import { type Invariant, pass, skip, violation } from "./types.js";

/**
 * Quote, approval and payment currency must all agree with the policy currency.
 *
 * A mismatch here is not a rounding problem — charging 1399 of the wrong unit is
 * a ~100x error in either direction, so this is checked explicitly rather than
 * assumed from a single-currency deployment.
 */
export const currencyInvariant: Invariant = {
  id: "INV-CURRENCY",
  title: "Quote, approval and payment currencies all match",
  severity: "critical",
  policyRefs: ["currency"],
  attribution: "integration",
  appliesAt: ["quote.created", "checkout.requested", "payment.verified"],
  evaluate(ctx) {
    const expected = ctx.policy.currency;
    const seen: Array<{ source: string; currency: string }> = [];

    if (ctx.quote) seen.push({ source: "quote", currency: ctx.quote.currency });
    if (ctx.approval)
      seen.push({ source: "approval", currency: ctx.approval.currency });
    if (ctx.checkoutIntent)
      seen.push({ source: "checkout", currency: ctx.checkoutIntent.currency });
    if (ctx.paymentAttempt)
      seen.push({ source: "payment", currency: ctx.paymentAttempt.currency });

    if (seen.length === 0) return skip("Nothing with a currency to compare");

    const mismatched = seen.filter((entry) => entry.currency !== expected);
    if (mismatched.length > 0) {
      return violation({
        message:
          `Currency mismatch: ` +
          mismatched
            .map((m) => `${m.source} is ${m.currency}`)
            .join(", ") +
          `, but the merchant policy currency is ${expected}.`,
        observed: { currencies: seen },
        expected: { currency: expected },
        moneyAtRiskMinor:
          ctx.checkoutIntent?.amountMinor ?? ctx.quote?.totalMinor ?? 0,
        remediation:
          "Carry currency explicitly through quote, approval and payment; never " +
          "default it.",
      });
    }

    return pass(`All ${seen.length} artefacts in ${expected}`);
  },
};
