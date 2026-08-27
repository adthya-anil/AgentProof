import { formatMinor } from "../../core/money.js";
import {
  type Invariant,
  pass,
  skip,
  violation,
} from "./types.js";

/**
 * Hard ceiling on any single transaction. The cheapest possible containment on
 * an agent that has misunderstood quantities or units.
 */
export const maxAmountInvariant: Invariant = {
  id: "INV-MAX-AMOUNT",
  title: "Transaction stays within the merchant's per-transaction ceiling",
  severity: "critical",
  policyRefs: ["transaction.maximum_amount"],
  attribution: "integration",
  appliesAt: ["quote.created", "checkout.requested"],
  evaluate(ctx) {
    const amount =
      ctx.checkoutIntent?.amountMinor ?? ctx.quote?.totalMinor ?? null;
    if (amount === null) return skip("No quote or checkout intent to evaluate");

    const ceiling = ctx.policy.transaction.maximumAmountMinor;
    if (amount > ceiling) {
      return violation({
        message:
          `Payable amount ${formatMinor(amount)} exceeds the per-transaction ` +
          `maximum of ${formatMinor(ceiling)}.`,
        observed: { amountMinor: amount },
        expected: { maximumAmountMinor: ceiling },
        moneyAtRiskMinor: amount - ceiling,
        remediation:
          "Split the basket or raise transaction.maximum_amount deliberately.",
      });
    }
    return pass(`${formatMinor(amount)} within ${formatMinor(ceiling)} ceiling`);
  },
};

/**
 * The buyer's approved amount is a hard upper bound on what can be charged.
 *
 * Checked against the approval receipt (not the quote), because the receipt is
 * the only artefact that records what a human actually agreed to. Also checks
 * the budget the buyer stated in natural language at quote time, which catches
 * an agent that overshoots "under ₹1,500" before anyone is asked to approve.
 */
export const budgetInvariant: Invariant = {
  id: "INV-BUDGET",
  title: "Charged amount never exceeds the buyer-approved amount",
  severity: "critical",
  policyRefs: ["pricing.payment_must_equal_approved_quote"],
  attribution: "integration",
  appliesAt: ["quote.created", "checkout.requested", "payment.verified"],
  evaluate(ctx) {
    // Pre-approval: honour the budget the buyer stated in words.
    if (ctx.checkpoint === "quote.created") {
      const budget = ctx.intent.constraints.maxBudgetMinor;
      if (budget === null || !ctx.quote) {
        return skip("Buyer stated no numeric budget");
      }
      if (ctx.quote.totalMinor > budget) {
        return violation({
          message:
            `Quote total ${formatMinor(ctx.quote.totalMinor)} exceeds the ` +
            `buyer's stated budget of ${formatMinor(budget)}.`,
          observed: { totalMinor: ctx.quote.totalMinor },
          expected: { maxBudgetMinor: budget },
          moneyAtRiskMinor: ctx.quote.totalMinor - budget,
          severity: "high",
          // The merchant cannot know what the buyer said in chat; the agent
          // chose these items. Overspending is the agent's error, not a bug in
          // the integration, so it must not count against the merchant.
          attribution: "agent",
          remediation: "Rebuild the bundle within the stated budget.",
        });
      }
      return pass(`Quote within stated budget ${formatMinor(budget)}`);
    }

    const charge = ctx.checkoutIntent?.amountMinor ?? ctx.paymentAttempt?.amountMinor;
    if (charge === undefined) return skip("No amount being charged yet");
    if (!ctx.approval) {
      return skip("No approval receipt; INV-CONFIRMATION owns that failure");
    }

    if (charge > ctx.approval.approvedAmountMinor) {
      return violation({
        message:
          `Attempting to charge ${formatMinor(charge)} against an approval for ` +
          `${formatMinor(ctx.approval.approvedAmountMinor)}.`,
        observed: { chargeMinor: charge },
        expected: { approvedAmountMinor: ctx.approval.approvedAmountMinor },
        moneyAtRiskMinor: charge - ctx.approval.approvedAmountMinor,
        remediation:
          "Re-quote and obtain fresh buyer approval for the higher amount.",
      });
    }

    // An undercharge is not a buyer risk, but it means approval and charge have
    // drifted, which the price-binding rule should have caught. Flag it.
    if (
      ctx.policy.pricing.paymentMustEqualApprovedQuote &&
      charge < ctx.approval.approvedAmountMinor
    ) {
      return violation({
        message:
          `Charge ${formatMinor(charge)} does not equal the approved amount ` +
          `${formatMinor(ctx.approval.approvedAmountMinor)}; policy requires an ` +
          `exact match.`,
        observed: { chargeMinor: charge },
        expected: { approvedAmountMinor: ctx.approval.approvedAmountMinor },
        moneyAtRiskMinor: 0,
        severity: "high",
        remediation: "Charge the approved amount or re-approve the new total.",
      });
    }

    return pass(`Charge equals approved ${formatMinor(charge)}`);
  },
};
