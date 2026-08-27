import { formatMinor } from "../../core/money.js";
import { type Invariant, pass, skip, violation } from "./types.js";

/**
 * A merchant order may only be confirmed against a verified, captured payment.
 *
 * "Verified" means the provider's own record was re-read and matched — not that
 * a callback said so. An integration that confirms on order *creation* ships
 * goods for payments that never completed.
 */
export const paymentStateInvariant: Invariant = {
  id: "INV-PAYMENT-STATE",
  title: "Only a verified captured payment can fulfil a merchant order",
  severity: "critical",
  policyRefs: ["transaction.one_payment_per_intent"],
  attribution: "integration",
  appliesAt: ["payment.verified", "order.fulfilled"],
  evaluate(ctx) {
    const attempt = ctx.paymentAttempt;
    if (!attempt) return skip("No payment attempt to evaluate");

    if (ctx.checkpoint === "order.fulfilled") {
      if (attempt.status !== "captured") {
        return violation({
          message:
            `Merchant order was fulfilled while the payment is '${attempt.status}'. ` +
            `Goods would ship for ${formatMinor(attempt.amountMinor)} that was ` +
            `never captured.`,
          observed: { paymentStatus: attempt.status, verified: attempt.verified },
          expected: { paymentStatus: "captured", verified: true },
          moneyAtRiskMinor: attempt.amountMinor,
          remediation:
            "Confirm the merchant order only after re-reading the provider " +
            "payment and observing a captured status.",
        });
      }
      if (!attempt.verified) {
        return violation({
          message:
            `Payment ${attempt.id} is marked captured but was never verified ` +
            `against the provider. The status is self-reported.`,
          observed: { verified: false },
          expected: { verified: true },
          moneyAtRiskMinor: attempt.amountMinor,
          remediation:
            "Fetch the payment from the provider API and match id, amount and " +
            "currency before trusting its status.",
        });
      }
    }

    // Whatever the state, the captured amount must match the authorised amount.
    const expectedAmount =
      ctx.checkoutIntent?.amountMinor ?? ctx.approval?.approvedAmountMinor;
    if (expectedAmount !== undefined && attempt.amountMinor !== expectedAmount) {
      return violation({
        message:
          `Payment amount ${formatMinor(attempt.amountMinor)} does not match the ` +
          `authorised amount ${formatMinor(expectedAmount)}.`,
        observed: { paymentAmountMinor: attempt.amountMinor },
        expected: { authorisedAmountMinor: expectedAmount },
        moneyAtRiskMinor: Math.abs(attempt.amountMinor - expectedAmount),
        remediation: "Create the provider order from the approved amount only.",
      });
    }

    return pass(`Payment ${attempt.status}, amount matches authorisation`);
  },
};
