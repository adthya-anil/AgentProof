import { BuyerAgent } from "../agent/buyer.js";
import type { LLM } from "../agent/llm.js";
import { REGRESSION_GOALS } from "./regression.js";
import type { Scenario, ScenarioContext, ScenarioOutcome } from "./types.js";

/**
 * Agent-driven variants of the fixed regression goals.
 *
 * The regression suite proves the Guard catches a defect when a journey walks
 * straight into it. That is necessary but it is not the interesting question. The
 * interesting question is whether a live agent, given only the buyer's words and
 * a set of tools, walks into it on its own — and what it does when the Guard says
 * no.
 *
 * Same goal, same target invariant, no scripted steps. Because the model chooses
 * freely, these journeys are *not* a stable recall measurement: a run where the
 * agent never reaches checkout tells you nothing about the invariant. That is why
 * they sit alongside the deterministic suite rather than replacing it, and why a
 * stalled journey is reported as `inconclusive` instead of being quietly counted
 * as a pass.
 */
export interface AgentDrivenOptions {
  /** A single model, or a pool to deal the goals across. */
  llm?: LLM;
  /**
   * Models to attempt every goal with — a cross-product, not a round-robin.
   *
   * Dealing one goal to each model would be cheaper but would answer a worse
   * question. The finding worth having is where two models *disagree* on the same
   * buyer request: one refusing a stacked discount while the other takes it says
   * something about how much the integration is relying on the agent's judgement.
   * You only see that if both attempted the same goal.
   */
  llms?: readonly LLM[];
  /**
   * Ceiling on tool calls per journey.
   *
   * Generous by default. A reasoning model often spends five or six calls
   * exploring the catalogue before it commits to a bundle, and a tight budget
   * makes it look like the agent gave up when really the harness cut it off.
   */
  maxToolCalls?: number;
  /** Restrict to specific regression ids. Empty means all of them. */
  only?: readonly string[];
}

export function agentDrivenScenarios(
  options: AgentDrivenOptions,
): readonly Scenario[] {
  const pool = resolvePool(options);
  const allow = new Set(options.only ?? []);
  const goals =
    allow.size > 0
      ? REGRESSION_GOALS.filter((g) => allow.has(g.id))
      : REGRESSION_GOALS;

  const scenarios: Scenario[] = [];

  for (const goal of goals) {
    for (const llm of pool) {
      const base = goal.id.replace(/^reg-\d+-/, "");
      scenarios.push({
        // The model belongs in the id when there is more than one, or two
        // journeys for the same goal would collide in the report and one would
        // silently overwrite the other.
        id:
          pool.length > 1
            ? `live-${base}-${shortModelName(llm.name)}`
            : `live-${base}`,
        title:
          pool.length > 1
            ? `${goal.title} — ${llm.name}`
            : `${goal.title} — live agent`,
        category: goal.category,
        driver: "agent" as const,
        assignedModel: llm.name,
        targetsInvariant: goal.targetsInvariant,
        intent: goal.intent,
        async execute(c: ScenarioContext): Promise<ScenarioOutcome> {
          const agent = new BuyerAgent({
            llm,
            // `c.tools`, never `c.guard` — otherwise a perturbation is bypassed.
            guard: c.tools,
            maxToolCalls: options.maxToolCalls ?? 24,
          });

          const run = await agent.run(c.intent);
          const last = run.transcript[run.transcript.length - 1];

          return {
            completed: run.reachedCheckout,
            note:
              `${run.transcript.length} tool calls; ${describeStop(run)}` +
              (last && !last.ok ? ` — last ${last.tool}: ${last.summary}` : ""),
            lastResult: run.lastResult,
            // What answered, not what we asked for.
            model: run.model,
            // Ran out of road rather than being decided by anything.
            inconclusive:
              !run.reachedCheckout &&
              (run.stopReason === "max_tool_calls" ||
                run.stopReason === "llm_error"),
          };
        },
      });
    }
  }

  return scenarios;
}

/**
 * Says who ended the journey, in plain words.
 *
 * `no_tool_call` is doing double duty in the raw stop reason: it covers both an
 * agent that voluntarily stopped to ask the buyer for approval — a good outcome —
 * and one that gave up after being blocked. A reader should not have to reverse-
 * engineer which from a tool count.
 */
function describeStop(run: {
  stopReason: string;
  reachedCheckout: boolean;
  lastResult?: { ok: boolean };
}): string {
  if (run.reachedCheckout) return "completed";
  if (run.stopReason === "no_tool_call") {
    return run.lastResult && !run.lastResult.ok
      ? "agent stopped after a block"
      : "agent declined to proceed";
  }
  return run.stopReason;
}

function resolvePool(options: AgentDrivenOptions): readonly LLM[] {
  if (options.llms && options.llms.length > 0) return options.llms;
  if (options.llm) return [options.llm];
  throw new Error("agentDrivenScenarios requires either `llm` or `llms`");
}

/** `anthropic:claude-opus-5` becomes `claude-opus-5`, for a readable id. */
function shortModelName(name: string): string {
  return name.split(":").pop()!.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}
