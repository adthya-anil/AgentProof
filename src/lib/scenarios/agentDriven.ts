import { BuyerAgent } from "../agent/buyer.js";
import type { LLM } from "../agent/llm.js";
import { describeAgentRun } from "./describeRun.js";
import { AGENT_UNREACHABLE_GOALS, REGRESSION_GOALS } from "./regression.js";
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
  /**
   * How goals are paired with models.
   *
   * `round-robin` (default) gives each goal to one model, so both models work and
   * nothing is executed twice. `cross-product` gives every goal to every model, which
   * doubles the run and is only worth it when the head-to-head *is* the finding.
   */
  pairing?: "round-robin" | "cross-product";
}

export function agentDrivenScenarios(
  options: AgentDrivenOptions,
): readonly Scenario[] {
  const pool = resolvePool(options);
  const allow = new Set(options.only ?? []);
  const goals = (
    allow.size > 0
      ? REGRESSION_GOALS.filter((g) => allow.has(g.id))
      : REGRESSION_GOALS
  ).filter((g) => !(g.id in AGENT_UNREACHABLE_GOALS));

  const scenarios: Scenario[] = [];

  /**
   * One model per goal unless a comparison was asked for.
   *
   * Attempting every goal with every model doubles the run to answer a question you
   * rarely need twice. Dealt round-robin instead, both models still work and no goal
   * is executed twice — and `compare` remains available for when the head-to-head is
   * the point.
   */
  const pairs: Array<{ goal: (typeof goals)[number]; llm: LLM }> =
    options.pairing === "cross-product"
      ? goals.flatMap((goal) => pool.map((llm) => ({ goal, llm })))
      : goals.map((goal, index) => ({
          goal,
          llm: pool[index % pool.length]!,
        }));

  {
    for (const { goal, llm } of pairs) {
      const base = goal.id.replace(/^reg-\d+-/, "");
      scenarios.push({
        // The model belongs in the id when there is more than one, or two
        // journeys for the same goal would collide in the report and one would
        // silently overwrite the other.
        // The model goes in the id only when the same goal appears more than once,
        // which now only happens in a comparison run.
        id:
          options.pairing === "cross-product" && pool.length > 1
            ? `live-${base}-${shortModelName(llm.name)}`
            : `live-${base}`,
        title: `${goal.title} — ${llm.name}`,
        category: goal.category,
        driver: "agent" as const,
        assignedModel: llm.name,
        targetsInvariant: goal.targetsInvariant,
        intent: goal.intent,
        // The mechanism travels with the label. Without these the twin cannot
        // reach its target invariant and a pass would mean nothing.
        ...(goal.interference ? { interference: goal.interference } : {}),
        ...(goal.faults ? { faults: goal.faults } : {}),
        async execute(c: ScenarioContext): Promise<ScenarioOutcome> {
          const agent = new BuyerAgent({
            llm,
            // `c.tools`, never `c.guard` — otherwise a perturbation is bypassed.
            guard: c.tools,
            maxToolCalls: options.maxToolCalls ?? 24,
          });

          return describeAgentRun(await agent.run(c.intent));
        },
      });
    }
  }

  return scenarios;
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
