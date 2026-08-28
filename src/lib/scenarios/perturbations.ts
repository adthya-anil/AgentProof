import { BuyerAgent } from "../agent/buyer.js";
import type { LLM } from "../agent/llm.js";
import { ScriptedLLM, encodeStrategy } from "../agent/scripted.js";
import { describeAgentRun } from "./describeRun.js";
import type { Scenario, ScenarioContext, ScenarioOutcome } from "./types.js";

/**
 * Transport-perturbation scenarios (§7C).
 *
 * Each drives a real buyer agent through a wrapper that injects latency,
 * duplicates a delivery, or replays an earlier request. The agent behaves
 * correctly throughout — it is the environment that misbehaves — which is the
 * point: every individual tool call is valid, and only the transaction as a whole
 * is unsafe.
 */

const HAMPER = [
  { product_id: "p-coffee-arabica", quantity: 1 },
  { product_id: "p-choc-dark-vegan", quantity: 1 },
  { product_id: "p-mug-ceramic", quantity: 1 },
  { product_id: "p-card-handmade", quantity: 1 },
];

/** Bundle → quote → approve → checkout → verify, threaded via $ref. */
const FULL_JOURNEY = [
  { tool: "create_bundle", args: { items: HAMPER, promo_codes: ["HAMPERCREDIT"] } },
  { tool: "create_quote", args: { bundle_id: "$ref:bundle_id" } },
  {
    tool: "approve_quote",
    args: {
      quote_id: "$ref:quote_id",
      approved_amount: "$ref:total",
      confirmation_text: "Yes, please go ahead.",
    },
  },
  {
    tool: "create_checkout",
    args: {
      quote_id: "$ref:quote_id",
      approval_receipt_id: "$ref:approval_receipt_id",
    },
  },
  {
    tool: "get_payment_status",
    args: { payment_attempt_id: "$ref:payment_attempt_id" },
  },
];

/**
 * Drives the journey that the transport will then misbehave around.
 *
 * When a real model is supplied it decides its own tool sequence and gets no
 * strategy hint. The scripted path exists only for a keyless CI run, and it is
 * chosen by the caller passing no model — never as a fallback when a real one
 * fails.
 *
 * The trade-off is real and is handled rather than hidden: a perturbation targets
 * a specific tool, so if the model never reaches `create_checkout` the fault never
 * fires and the journey proved nothing about it. The runner detects exactly that
 * — a declared perturbation that never applied — and reports the journey
 * `inconclusive` instead of letting it pass for a clean result.
 */
async function driveAgent(
  c: ScenarioContext,
  label: string,
  steps: typeof FULL_JOURNEY,
  llm?: LLM,
): Promise<ScenarioOutcome> {
  const agent = new BuyerAgent({
    llm: llm ?? new ScriptedLLM(),
    // Must be `c.tools`, not `c.guard`, or the perturbation is bypassed.
    guard: c.tools,
    // A real model is told the goal and nothing else. Handing it the scripted
    // sequence would make "live agent" a costume over a replay.
    systemSuffix: llm ? "" : encodeStrategy({ label, steps }),
    maxToolCalls: 24,
  });

  return describeAgentRun(await agent.run(c.intent));
}

/**
 * Transport perturbations (§7C).
 *
 * What is under test here is the transport — a duplicated delivery, a replay, a
 * clock jump — not the agent. Each declares the tool its fault targets, and the
 * agent driving it is supplied by the caller.
 */
const PERTURBATIONS: readonly PerturbationTemplate[] = Object.freeze([
  {
    id: "pert-01-delayed-response",
    title: "Buyer pauses mid-journey and the quote expires before checkout",
    category: "state_perturbation",
    targetsInvariant: "INV-QUOTE-EXPIRY",
    intent: {
      /**
       * Must authorise the purchase.
       *
       * This used to read "I'll think about it before confirming", which was a
       * scenario that could not test itself: the agent is instructed never to
       * self-approve without authorisation, so a real model correctly stopped at
       * the quote and `create_checkout` — the tool this fault targets — was never
       * reached. The scripted version hid the contradiction by forcing the steps.
       *
       * The pause belongs to the transport, not the buyer. The clock jump below is
       * what expires the quote, while the agent does nothing wrong.
       */
      utterance:
        "A vegan coffee hamper under ₹1,500 — go ahead and buy it for me.",
      maxBudget: 1500,
      requireVegan: true,
    },
    // The pause lands between approval and checkout, so the price guarantee
    // lapses while the agent is doing nothing wrong.
    perturbation: {
      delay: { tool: "create_checkout", advanceClockMinutes: 15, realMs: 5 },
    },
    label: "delayed checkout",
  },

  {
    id: "pert-02-duplicated-delivery",
    title: "Checkout request is delivered twice by the transport",
    category: "state_perturbation",
    targetsInvariant: "INV-IDEMPOTENCY",
    intent: {
      utterance: "Order the coffee hamper, under ₹1,500.",
      maxBudget: 1500,
      requireVegan: true,
    },
    // At-least-once delivery: the agent asked once, the merchant heard twice.
    perturbation: { duplicate: { tool: "create_checkout" } },
    label: "duplicated checkout delivery",
  },

  {
    id: "pert-03-replayed-approval",
    title: "An earlier approval request is replayed after checkout",
    category: "state_perturbation",
    targetsInvariant: null,
    intent: {
      utterance:
        "A coffee hamper for a birthday, under ₹1,500 — please go ahead and order it.",
      maxBudget: 1500,
      requireVegan: true,
      occasion: "birthday",
    },
    // Replaying approve_quote must not mint a second receipt that could later be
    // paired with a different checkout.
    perturbation: { replay: { replay: "approve_quote", after: "create_checkout" } },
    label: "replayed approval",
  },

  {
    id: "pert-04-duplicated-approval",
    title: "Approval is delivered twice before checkout",
    category: "state_perturbation",
    targetsInvariant: null,
    intent: {
      utterance:
        "The vegan coffee hamper please, under ₹1,500 — go ahead and buy it.",
      maxBudget: 1500,
      requireVegan: true,
    },
    perturbation: { duplicate: { tool: "approve_quote" } },
    label: "duplicated approval",
  },
]);

/** A perturbation minus the agent that will drive it. */
type PerturbationTemplate = Omit<Scenario, "driver" | "execute"> & {
  /** Names the scripted strategy, used only on the keyless path. */
  label: string;
};

/**
 * Perturbations driven by real models, one scenario per model.
 *
 * Same faults, but the agent is a live model with no strategy hint. This is the
 * honest version of §7C: the transport misbehaves around a journey the model
 * actually chose, rather than around a replay.
 */
export function perturbationScenarios(
  llms: readonly LLM[],
): readonly Scenario[] {
  const scenarios: Scenario[] = [];
  for (const template of PERTURBATIONS) {
    for (const llm of llms) {
      const { label, ...rest } = template;
      scenarios.push({
        ...rest,
        id:
          llms.length > 1
            ? `${template.id}-${shortModelName(llm.name)}`
            : template.id,
        title: llms.length > 1 ? `${template.title} — ${llm.name}` : template.title,
        driver: "agent",
        assignedModel: llm.name,
        execute: (c) => driveAgent(c, label, FULL_JOURNEY, llm),
      });
    }
  }
  return scenarios;
}

/**
 * The keyless perturbation set: scripted tool sequences, no model.
 *
 * Kept for CI and for `LLM_ADAPTER=scripted`, and reachable only by asking for it.
 * Never used to paper over a real model that failed.
 */
export const PERTURBATION_SCENARIOS: readonly Scenario[] = Object.freeze(
  PERTURBATIONS.map(({ label, ...rest }) => ({
    ...rest,
    driver: "deterministic" as const,
    execute: (c: ScenarioContext) => driveAgent(c, label, FULL_JOURNEY),
  })),
);

function shortModelName(name: string): string {
  return name.split(":").pop()!.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}
