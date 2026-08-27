import { BuyerAgent } from "../agent/buyer.js";
import { ScriptedLLM, encodeStrategy } from "../agent/scripted.js";
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

async function driveAgent(
  c: ScenarioContext,
  label: string,
  steps: typeof FULL_JOURNEY,
): Promise<ScenarioOutcome> {
  const agent = new BuyerAgent({
    llm: new ScriptedLLM(),
    // Must be `c.tools`, not `c.guard`, or the perturbation is bypassed.
    guard: c.tools,
    systemSuffix: encodeStrategy({ label, steps }),
  });

  const run = await agent.run(c.intent);
  const last = run.transcript[run.transcript.length - 1];
  return {
    completed: run.reachedCheckout,
    note:
      `${run.transcript.length} tool calls; ${run.stopReason}` +
      (last && !last.ok ? ` — last ${last.tool}: ${last.summary}` : ""),
    lastResult: run.lastResult,
  };
}

export const PERTURBATION_SCENARIOS: readonly Scenario[] = Object.freeze([
  {
    id: "pert-01-delayed-response",
    title: "Buyer pauses mid-journey and the quote expires before checkout",
    category: "state_perturbation",
    targetsInvariant: "INV-QUOTE-EXPIRY",
    intent: {
      utterance:
        "A vegan coffee hamper under ₹1,500 — I'll think about it before confirming.",
      maxBudget: 1500,
      requireVegan: true,
    },
    // The pause lands between approval and checkout, so the price guarantee
    // lapses while the agent is doing nothing wrong.
    perturbation: {
      delay: { tool: "create_checkout", advanceClockMinutes: 15, realMs: 5 },
    },
    async execute(c) {
      return driveAgent(c, "delayed checkout", FULL_JOURNEY);
    },
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
    async execute(c) {
      return driveAgent(c, "duplicated checkout delivery", FULL_JOURNEY);
    },
  },

  {
    id: "pert-03-replayed-approval",
    title: "An earlier approval request is replayed after checkout",
    category: "state_perturbation",
    targetsInvariant: null,
    intent: {
      utterance: "A coffee hamper for a birthday, under ₹1,500.",
      maxBudget: 1500,
      requireVegan: true,
      occasion: "birthday",
    },
    // Replaying approve_quote must not mint a second receipt that could later be
    // paired with a different checkout.
    perturbation: { replay: { replay: "approve_quote", after: "create_checkout" } },
    async execute(c) {
      return driveAgent(c, "replayed approval", FULL_JOURNEY);
    },
  },

  {
    id: "pert-04-duplicated-approval",
    title: "Approval is delivered twice before checkout",
    category: "state_perturbation",
    targetsInvariant: null,
    intent: {
      utterance: "The vegan coffee hamper please, under ₹1,500.",
      maxBudget: 1500,
      requireVegan: true,
    },
    perturbation: { duplicate: { tool: "approve_quote" } },
    async execute(c) {
      return driveAgent(c, "duplicated approval", FULL_JOURNEY);
    },
  },
]);
