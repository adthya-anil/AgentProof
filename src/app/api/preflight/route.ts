import {
  assignRoles,
  describePool,
  llmFromEnv,
  llmPoolFromEnv,
} from "@/lib/agent/factory";
import { loadDotEnv } from "@/lib/core/env";
import { toMajor } from "@/lib/core/money";
import { getLatestRun, recordRun } from "@/lib/dashboard/runStore";
import { EMPTY_INTEL, intelFrom } from "@/lib/scenarios/intel.js";
import { MutationSet } from "@/lib/hamperhub/mutations";
import { razorpayFromEnv } from "@/lib/harness";
import { loadPolicyFromFile } from "@/lib/policy/load";
import { runSuite } from "@/lib/runner/run";
import { assembleSuite, type SuiteMode } from "@/lib/scenarios/index";

/**
 * Runs a preflight suite on demand, streaming progress.
 *
 * Deliberately triggered rather than automatic. With a real model each journey is
 * a full multi-turn tool-calling conversation, so a suite costs real time and
 * real tokens — that is a developer's decision to make, not something a page load
 * should do behind their back.
 *
 * Streams per-journey results so a long run is legible while it happens instead
 * of being a spinner that ends in a table.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 3600;

export async function GET(request: Request): Promise<Response> {
  loadDotEnv();

  const url = new URL(request.url);
  const variant =
    url.searchParams.get("variant") === "fixed" ? "fixed" : "vulnerable";
  const generatedCount = clamp(url.searchParams.get("generated"), 9, 0, 12);
  const mode = parseMode(url.searchParams.get("mode"));
  /**
   * Three named sizes, because five independent dropdowns asked a developer to
   * assemble a sensible run out of parts. Each preset is a defensible whole.
   */
  const size = parseSize(url.searchParams.get("size"));
  const preset = PRESETS[size];
  const roleMode = preset.roleMode;
  // Comma-separated regression ids. Not surfaced in the UI, but it makes a
  // single live journey cheap to reproduce from a shell or a CI step.
  const liveGoals = (url.searchParams.get("liveGoals") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const startedAt = Date.now();

      try {
        /**
         * Payments: simulated unless real ones are asked for.
         *
         * This route used to build a Razorpay adapter, print its name in the
         * header, and then never pass it to the runner — so the report announced
         * "razorpay test mode (rzp_test_…)" while every journey ran against the
         * simulated provider. A false claim about money is the single worst thing
         * this tool could put on a screen.
         *
         * Simulated stays the default because a suite is dozens of journeys and a
         * real order per checkout is a lot of live side effects. But the label now
         * describes what actually happened, and real can be chosen deliberately.
         */
        const wantsRealPayments = url.searchParams.get("payments") === "razorpay";
        const realPayments = wantsRealPayments ? razorpayFromEnv() : null;

        if (wantsRealPayments && !realPayments) {
          send({
            kind: "error",
            message:
              "Real payments were requested but RAZORPAY_KEY_ID and " +
              "RAZORPAY_KEY_SECRET are not both set. Nothing was substituted — a " +
              "run labelled as using Razorpay must actually use it.",
          });
          controller.enqueue(encoder.encode("event: end\ndata: {}\n\n"));
          controller.close();
          return;
        }

        const llm = llmFromEnv();
        // Every real model the environment can reach. When two families are
        // configured, each regression goal is attempted by both — a merchant does
        // not get to pick which agent shops their store.
        const requested = url.searchParams.get("models");
        const pool = requested === "primary" ? [llm] : llmPoolFromEnv();

        // Refuse rather than substitute. A mode that promises live agents and
        // silently delivers replayed scripts is worse than an error, because the
        // report that comes out of it looks exactly like a real one.
        if (mode !== "deterministic" && pool.filter((m) => m.isReal).length === 0) {
          send({
            kind: "error",
            message:
              "No real model is configured, so there is nothing to drive a " +
              "live-agent journey. Set LLM_ADAPTER=openai with LLM_API_KEY, " +
              "LLM_MODEL and LLM_BASE_URL (and optionally ANTHROPIC_MODEL for a " +
              "second family), then restart the server — .env is read once at " +
              'startup. Or choose "Fixed repros only" to run without a model.',
          });
          controller.enqueue(encoder.encode("event: end\ndata: {}\n\n"));
          controller.close();
          return;
        }

        const { adversary, buyers } = assignRoles(pool, roleMode);

        /**
         * What the previous run revealed, handed to the adversary.
         *
         * Generation had always accepted this and never received it, so each run
         * invented goals with no knowledge of where the shop was already weak or
         * which rules nothing had reached. Feeding it back makes a second run aim at
         * what survived the first instead of re-rolling the dice.
         */
        const previous = await getLatestRun(variant);
        const intel = previous ? intelFrom(previous.suite) : EMPTY_INTEL;

        const policy = loadPolicyFromFile();
        // Describes what the journeys will really use, not what is merely
        // configured in the environment.
        const paymentAdapter = realPayments
          ? `razorpay test mode (${process.env.RAZORPAY_KEY_ID})`
          : "simulated (no real payment calls)";

        send({
          kind: "start",
          variant,
          mode,
          model: llm.name,
          modelIsReal: llm.isReal,
          pool: pool.map((m) => m.name),
          size,
          roles: roleMode,
          adversaryModel: adversary?.name ?? null,
          buyerModels: buyers.map((m) => m.name),
          intel: {
            tripped: intel.tripped.length,
            neverExercised: intel.neverExercised.length,
            survived: intel.survived.length,
          },
          paymentAdapter,
        });

        send({ kind: "phase", note: "Generating scenarios" });
        const assembled = await assembleSuite({
          llm,
          llms: buyers.length > 0 ? buyers : pool,
          ...(adversary ? { adversary } : {}),
          intel,
          policy,
          generatedCount: preset.generated,
          mode: preset.mode,
          roleMode: preset.roleMode,
          includePerturbations: preset.perturbations,
          ...(liveGoals.length > 0 ? { liveGoals } : {}),
        });

        send({
          kind: "assembled",
          total: assembled.scenarios.length,
          regression: assembled.regressionCount,
          perturbation: assembled.perturbationCount,
          live: assembled.liveCount,
          generated: assembled.generatedCount,
          agentDriven: assembled.scenarios.filter((s) => s.driver === "agent")
            .length,
          driverModels: assembled.driverModels,
          scenarios: assembled.scenarios.map((s) => ({
            id: s.id,
            title: s.title,
            category: s.category,
            driver: s.driver,
            assignedModel: s.assignedModel ?? null,
            targetsInvariant: s.targetsInvariant,
          })),
        });

        const suite = await runSuite(assembled.scenarios, {
          // The provider the journeys actually talk to.
          ...(realPayments ? { paymentProvider: realPayments } : {}),
          mutations:
            variant === "vulnerable"
              ? MutationSet.vulnerable()
              : MutationSet.fixed(),
          runId: `preflight_${variant}`,
          onScenarioStart: (scenario, index, total) => {
            send({
              kind: "scenario_start",
              index,
              total,
              id: scenario.id,
              title: scenario.title,
              category: scenario.category,
            });
          },
          onJourney: (journey, index, total) => {
            send({
              kind: "journey",
              index,
              total,
              id: journey.scenarioId,
              title: journey.title,
              driver: journey.driver,
              model: journey.model,
              disposition: journey.disposition,
              note: journey.note,
              fired: journey.firedInvariants,
              defects: journey.integrationDefects.length,
              moneyAtRisk: toMajor(journey.moneyAtRiskMinor),
              providerOrders: journey.providerOrders,
              toolPath: journey.toolPath,
              durationMs: journey.durationMs,
              /**
               * A compact account of what happened, so each row is explorable in
               * place. Types and reasons only — the full payloads live on the replay
               * page, and shipping them for every journey would make the stream
               * heavy for detail most rows never need opened.
               */
              steps: journey.auditTrail.map((e) => ({
                seq: e.seq,
                type: e.type,
                tool: e.toolName,
                reason: e.reason,
                decision: e.decision,
              })),
              violations: journey.violations.map((v) => ({
                invariant: v.invariantId,
                severity: v.severity,
                message: v.message,
                remediation: v.remediation,
              })),
            });
          },
        });

        const stored = await recordRun({
          variant,
          suite,
          startedAt,
          model: describePool(pool),
          modelIsReal: pool.some((m) => m.isReal),
          paymentAdapter,
          regressionCount: assembled.regressionCount,
          perturbationCount: assembled.perturbationCount,
          liveCount: assembled.liveCount,
          generatedCount: assembled.generatedCount,
          policy,
        });

        send({
          kind: "done",
          runId: stored.id,
          persistedSuiteId: stored.persistedSuiteId,
          readiness: suite.readiness,
          passed: suite.passed,
          safelyRejected: suite.safelyRejected,
          escalated: suite.escalated,
          unsafeViolations: suite.unsafeViolations,
          inconclusive: suite.inconclusive,
          agentDriven: suite.agentDriven,
          byModel: suite.byModel,
          errored: suite.errored,
          escapes: suite.moneyCriticalEscapes,
          moneyAtRisk: toMajor(suite.moneyAtRiskMinor),
          durationMs: suite.durationMs,
          metrics: suite.metrics,
        });
      } catch (error) {
        send({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }

      if (!closed) {
        controller.enqueue(encoder.encode("event: end\ndata: {}\n\n"));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function clamp(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * What each preset actually runs.
 *
 * Quick is the default because the expensive half of a suite is the live-agent
 * journeys, and a first run should be readable in one screen rather than a
 * five-minute commitment. Compare is the only preset that attempts a goal twice, and
 * it says so in its name.
 */
const PRESETS = {
  quick: {
    mode: "deterministic" as SuiteMode,
    roleMode: "split" as const,
    generated: 3,
    perturbations: false,
    label: "15 journeys — 12 fixed repros + 3 AI-invented",
  },
  standard: {
    mode: "both" as SuiteMode,
    roleMode: "split" as const,
    generated: 3,
    perturbations: true,
    label: "30 journeys — adds live-agent replays and transport faults",
  },
  compare: {
    mode: "both" as SuiteMode,
    roleMode: "compare" as const,
    generated: 3,
    perturbations: true,
    label: "45 journeys — every goal attempted by every model",
  },
} as const;

type RunSize = keyof typeof PRESETS;

function parseSize(raw: string | null): RunSize {
  return raw === "standard" || raw === "compare" ? raw : "quick";
}

function parseMode(raw: string | null): SuiteMode {
  // "both" here, unlike the library default: someone who opened this screen and
  // pressed the button wants to see the live agent work, not just a replay.
  return raw === "deterministic" || raw === "agent" || raw === "both"
    ? raw
    : "both";
}
