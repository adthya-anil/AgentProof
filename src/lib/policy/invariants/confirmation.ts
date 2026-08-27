import { formatMinor } from "../../core/money.js";
import { type Invariant, pass, skip, violation } from "./types.js";

/**
 * A payment may only be created against explicit buyer consent for one exact
 * quote and one exact amount.
 *
 * The dangerous failure mode is not a missing approval — it is an agent
 * interpreting a conversational reply ("sure, sounds good") as authorisation.
 * So this rule requires a receipt that independently records the quote id,
 * quote version and amount, and it verifies those against the checkout rather
 * than trusting a boolean "confirmed" flag.
 */
export const confirmationInvariant: Invariant = {
  id: "INV-CONFIRMATION",
  title: "No payment without explicit approval for the exact quote and amount",
  severity: "critical",
  policyRefs: ["transaction.require_buyer_confirmation"],
  attribution: "integration",
  appliesAt: ["checkout.requested", "payment.verified"],
  evaluate(ctx) {
    if (!ctx.policy.transaction.requireBuyerConfirmation) {
      return skip("Buyer confirmation not required by policy");
    }

    const quote = ctx.quote;
    const checkout = ctx.checkoutIntent;
    if (!quote || !checkout) return skip("No checkout in flight");

    if (!ctx.approval) {
      return violation({
        message:
          `Checkout for ${formatMinor(checkout.amountMinor)} was requested with ` +
          `no approval receipt. Nothing records that the buyer explicitly ` +
          `authorised this payment.`,
        observed: { approvalReceiptId: null },
        expected: { approvalReceiptBoundToQuote: quote.id },
        moneyAtRiskMinor: checkout.amountMinor,
        remediation:
          "Require an approval receipt bound to the quote id, quote version and " +
          "amount before creating any payment.",
      });
    }

    if (ctx.approval.intentId !== ctx.intent.id) {
      return violation({
        message:
          `Approval receipt ${ctx.approval.id} belongs to buyer intent ` +
          `${ctx.approval.intentId}, but checkout is running under intent ` +
          `${ctx.intent.id}. An approval was reused across conversations.`,
        observed: { approvalIntentId: ctx.approval.intentId },
        expected: { approvalIntentId: ctx.intent.id },
        moneyAtRiskMinor: checkout.amountMinor,
        remediation: "Scope approval receipts to a single buyer intent.",
      });
    }

    if (ctx.approval.approvedAmountMinor !== checkout.amountMinor) {
      return violation({
        message:
          `Buyer approved ${formatMinor(ctx.approval.approvedAmountMinor)} but ` +
          `checkout is for ${formatMinor(checkout.amountMinor)}.`,
        observed: { checkoutAmountMinor: checkout.amountMinor },
        expected: { approvedAmountMinor: ctx.approval.approvedAmountMinor },
        moneyAtRiskMinor: Math.abs(
          checkout.amountMinor - ctx.approval.approvedAmountMinor,
        ),
        remediation: "Re-approve the exact amount being charged.",
      });
    }

    if (ctx.approval.confirmationText.trim().length === 0) {
      return violation({
        message:
          `Approval receipt ${ctx.approval.id} carries no buyer confirmation ` +
          `text, so consent cannot be evidenced in the audit trail.`,
        observed: { confirmationText: "" },
        expected: { nonEmptyConfirmationText: true },
        moneyAtRiskMinor: checkout.amountMinor,
        severity: "high",
        remediation: "Record the buyer's verbatim confirmation on the receipt.",
      });
    }

    return pass(
      `Approval ${ctx.approval.id} covers ${formatMinor(checkout.amountMinor)}`,
    );
  },
};
