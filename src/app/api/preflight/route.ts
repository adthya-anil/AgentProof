import { describePool, llmFromEnv, llmPoolFromEnv } from "@/lib/agent/factory";
import { loadDotEnv } from "@/lib/core/env";
import { toMajor } from "@/lib/core/money";
import { recordRun } from "@/lib/dashboard/runStore";
import { MutationSet } from "@/lib/hamperhub/mutations";
import { describeAdapter, selectPaymentAdapter } from "@/lib/payments/factory";
import { IdFactory } from "@/lib/core/ids";
import { ManualClock } from "@/lib/core/clock";
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

        const policy = loadPolicyFromFile();
        const adapter = selectPaymentAdapter({
          ids: new IdFactory("preflight"),
          clock: new ManualClock(),
        });

        send({
          kind: "start",
          variant,
          mode,
          model: llm.name,
          modelIsReal: llm.isReal,
          pool: pool.map((m) => m.name),
          paymentAdapter: describeAdapter(adapter),
        });

        send({ kind: "phase", note: "Generating scenarios" });
        const assembled = await assembleSuite({
          llm,
          llms: pool,
          policy,
          generatedCount,
          mode,
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
            });
          },
        });

        const stored = await recordRun({
          variant,
          suite,
          startedAt,
          model: describePool(pool),
          modelIsReal: pool.some((m) => m.isReal),
          paymentAdapter: describeAdapter(adapter),
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

function parseMode(raw: string | null): SuiteMode {
  // "both" here, unlike the library default: someone who opened this screen and
  // pressed the button wants to see the live agent work, not just a replay.
  return raw === "deterministic" || raw === "agent" || raw === "both"
    ? raw
    : "both";
}
