import type { AuditEvent } from "../audit/events.js";
import type { Minor } from "../core/money.js";
import { MutationSet } from "../hamperhub/mutations.js";
import { collectFailureFacts, renderDeterministicExplanation } from "../report/explain.js";
import { type JourneyResult, runScenario } from "../runner/run.js";
import { PERTURBATION_SCENARIOS } from "../scenarios/perturbations.js";
import { REGRESSION_SCENARIOS } from "../scenarios/regression.js";
import type { Scenario } from "../scenarios/types.js";
import type { Violation } from "../policy/violations.js";
import type { IntegrationVariant } from "./data.js";

/**
 * Runs one buyer journey on demand for the storefront demo.
 *
 * This is the "show the integration" view: a real buyer request, executed live
 * against either the vulnerable or the fixed integration, rendered as the agent's
 * tool calls plus the Guard's verdict at each checkpoint.
 *
 * The same request against both variants is the single most useful thing to put in
 * front of a reviewer, because the buyer's behaviour is identical and only the
 * merchant's code differs. It removes any suspicion that the failing case was
 * provoked by a different input.
 */

/** Curated buyer requests, chosen to cover the demo narrative. */
export interface ShowcaseOption {
  key: string;
  scenarioId: string;
  label: string;
  /** Why this one is worth showing. */
  blurb: string;
}

export const SHOWCASE_OPTIONS: readonly ShowcaseOption[] = Object.freeze([
  {
    key: "happy",
    scenarioId: "reg-01-normal",
    label: "Vegan coffee birthday hamper under ₹1,500",
    blurb:
      "The intended journey. Completes on both integrations and charges exactly " +
      "the approved ₹1,399.",
  },
  {
    key: "discounts",
    scenarioId: "reg-09-discount-stacking",
    label: "Apply every discount I qualify for",
    blurb:
      "Two promotions, each under the 5% cap, that stack to 8.7% when applied " +
      "in sequence.",
  },
  {
    key: "allergy",
    scenarioId: "reg-10-unknown-allergen",
    label: "Chocolate box, but I have a peanut allergy",
    blurb:
      "One product has no published allergen data. Unknown must never be read " +
      "as safe.",
  },
  {
    key: "retry",
    scenarioId: "reg-05-duplicate-payment",
    label: "Order it, and retry if the payment call fails",
    blurb:
      "The payment call times out after the order was really created, so the " +
      "agent retries.",
  },
  {
    key: "stockout",
    scenarioId: "reg-08-inventory-changed",
    label: "Order it — but stock vanishes after approval",
    blurb:
      "Inventory is corrected to zero between approval and payment. Checkout " +
      "must stop before money moves.",
  },
  {
    key: "pricechange",
    scenarioId: "reg-07-price-changed",
    label: "Order it — but the price rises after approval",
    blurb:
      "The buyer agreed to one amount. The catalog then moves underneath the " +
      "approval.",
  },
  {
    key: "delay",
    scenarioId: "pert-01-delayed-response",
    label: "Buyer pauses, then confirms much later",
    blurb:
      "A 15-minute pause between approval and checkout expires the quote the " +
      "merchant guaranteed.",
  },
  {
    key: "duplicate",
    scenarioId: "pert-02-duplicated-delivery",
    label: "The checkout request is delivered twice",
    blurb:
      "At-least-once delivery. The agent asked once; the merchant heard it " +
      "twice.",
  },
]);

export interface ShowcaseToolCall {
  seq: number;
  tool: string;
  /** Compact rendering of the arguments the agent chose. */
  args: string;
  ok: boolean;
  detail: string;
}

export interface ShowcaseQuoteLine {
  name: string;
  quantity: number;
  lineTotal: number;
}

export interface ShowcaseQuote {
  quoteId: string;
  lines: ShowcaseQuoteLine[];
  discounts: Array<{ code: string; amount: number }>;
  subtotal: number;
  total: number;
}

export interface ShowcaseCheckpoint {
  checkpoint: string;
  decision: string;
  reason: string;
  evaluated: number;
  passed: number;
}

export interface ShowcaseResult {
  option: ShowcaseOption;
  variant: IntegrationVariant;
  utterance: string | null;
  toolCalls: ShowcaseToolCall[];
  quote: ShowcaseQuote | null;
  checkpoints: ShowcaseCheckpoint[];
  violations: Violation[];
  escalations: Violation[];
  /** Findings that mean the merchant's code is at fault. */
  defects: Violation[];
  disposition: JourneyResult["disposition"];
  note: string;
  providerOrders: number;
  moneyAtRiskMinor: Minor;
  perturbations: string[];
  /** Deterministic developer explanation. Always present. */
  explanation: string;
  auditTrail: readonly AuditEvent[];
  auditChainOk: boolean;
  durationMs: number;
}

function allScenarios(): Scenario[] {
  return [...REGRESSION_SCENARIOS, ...PERTURBATION_SCENARIOS];
}

export function showcaseOptionByKey(key: string): ShowcaseOption {
  return (
    SHOWCASE_OPTIONS.find((option) => option.key === key) ?? SHOWCASE_OPTIONS[0]!
  );
}

export async function runShowcase(
  key: string,
  variant: IntegrationVariant,
): Promise<ShowcaseResult | null> {
  const option = showcaseOptionByKey(key);
  const scenario = allScenarios().find((s) => s.id === option.scenarioId);
  if (!scenario) return null;

  const journey = await runScenario(scenario, {
    mutations:
      variant === "vulnerable" ? MutationSet.vulnerable() : MutationSet.fixed(),
    runId: `showcase_${variant}_${option.key}`,
  });

  return {
    option,
    variant,
    utterance: utteranceOf(journey.auditTrail),
    toolCalls: extractToolCalls(journey.auditTrail),
    quote: extractQuote(journey.auditTrail),
    checkpoints: extractCheckpoints(journey.auditTrail),
    violations: journey.violations,
    escalations: journey.escalations,
    defects: journey.integrationDefects,
    disposition: journey.disposition,
    note: journey.note,
    providerOrders: journey.providerOrders,
    moneyAtRiskMinor: journey.moneyAtRiskMinor,
    perturbations: journey.perturbations.map((p) => p.detail),
    explanation: renderDeterministicExplanation(collectFailureFacts(journey)),
    auditTrail: journey.auditTrail,
    auditChainOk: journey.auditChainOk,
    durationMs: journey.durationMs,
  };
}

// -- extraction -------------------------------------------------------------

function utteranceOf(events: readonly AuditEvent[]): string | null {
  const intent = events.find((e) => e.type === "intent.received");
  const input = intent?.input as { utterance?: string } | undefined;
  return input?.utterance ?? null;
}

/**
 * Pairs each tool request with the outcome event that follows it.
 *
 * Reads the audit trail rather than the agent's own transcript, so what is shown
 * is the merchant's record of what happened, not the agent's account of it.
 */
function extractToolCalls(events: readonly AuditEvent[]): ShowcaseToolCall[] {
  const calls: ShowcaseToolCall[] = [];
  let seq = 0;

  events.forEach((event, index) => {
    if (event.type !== "agent.tool_requested") return;
    seq += 1;

    const outcome = events.slice(index + 1).find((e) =>
      [
        "tool.executed",
        "tool.rejected",
        "quote.created",
        "quote.approved",
        "checkout.requested",
        "checkout.blocked",
        "razorpay.order_created",
        "payment.verified",
        "payment.failed",
        "agent.tool_requested",
      ].includes(e.type),
    );

    const failed =
      outcome === undefined ||
      outcome.type === "tool.rejected" ||
      outcome.type === "checkout.blocked" ||
      outcome.type === "payment.failed";

    calls.push({
      seq,
      tool: event.toolName ?? "unknown",
      args: compactArgs(event.input),
      ok: !failed,
      detail: outcome?.reason ?? (failed ? "no outcome recorded" : "accepted"),
    });
  });

  return calls;
}

function extractQuote(events: readonly AuditEvent[]): ShowcaseQuote | null {
  const created = events.find((e) => e.type === "quote.created");
  if (!created?.output) return null;
  const output = created.output as {
    quote_id?: string;
    line_items?: Array<{ name?: string; quantity?: number; line_total?: number }>;
    discounts?: Array<{ code?: string; amount?: number }>;
    subtotal?: number;
    total?: number;
  };

  return {
    quoteId: output.quote_id ?? "",
    lines: (output.line_items ?? []).map((line) => ({
      name: line.name ?? "",
      quantity: line.quantity ?? 0,
      lineTotal: line.line_total ?? 0,
    })),
    discounts: (output.discounts ?? []).map((d) => ({
      code: d.code ?? "",
      amount: d.amount ?? 0,
    })),
    subtotal: output.subtotal ?? 0,
    total: output.total ?? 0,
  };
}

function extractCheckpoints(events: readonly AuditEvent[]): ShowcaseCheckpoint[] {
  return events
    .filter((e) => e.type === "policy.evaluated")
    .map((event) => {
      const output = (event.output ?? {}) as {
        checkpoint?: string;
        evaluated?: number;
        passed?: number;
      };
      return {
        checkpoint: output.checkpoint ?? "",
        decision: event.decision ?? "",
        reason: event.reason ?? "",
        evaluated: output.evaluated ?? 0,
        passed: output.passed ?? 0,
      };
    });
}

function compactArgs(input: unknown): string {
  if (input === null || input === undefined) return "";
  const json = JSON.stringify(input);
  return json.length > 150 ? `${json.slice(0, 150)}…` : json;
}
