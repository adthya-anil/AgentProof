import { type Invariant, pass, skip, violation } from "./types.js";

/**
 * An expired quote cannot be used for payment.
 *
 * Expiry is the merchant's guarantee window on a price. Enforcing it is what
 * makes "the price is held for 10 minutes" true rather than aspirational — and
 * an agent that pauses for buyer input will routinely cross that boundary.
 *
 * The quote's own expiry window is also validated against policy, so an
 * integration cannot quietly issue 24-hour quotes under a 10-minute policy.
 */
export const quoteExpiryInvariant: Invariant = {
  id: "INV-QUOTE-EXPIRY",
  title: "An expired quote cannot be used for payment",
  severity: "critical",
  policyRefs: ["transaction.quote_expiry_minutes"],
  attribution: "integration",
  appliesAt: ["quote.approved", "checkout.requested"],
  evaluate(ctx) {
    const quote = ctx.quote;
    if (!quote) return skip("No quote to evaluate");

    const nowMs = ctx.clock.nowMs();
    const expiresMs = quote.expiresAt.getTime();

    if (nowMs > expiresMs) {
      const ageSeconds = Math.round((nowMs - quote.createdAt.getTime()) / 1000);
      const overdueSeconds = Math.round((nowMs - expiresMs) / 1000);
      return violation({
        message:
          `Quote ${quote.id} expired ${overdueSeconds}s ago ` +
          `(created ${ageSeconds}s ago, policy window ` +
          `${ctx.policy.transaction.quoteExpiryMinutes} minutes). The merchant no ` +
          `longer guarantees this price.`,
        observed: {
          now: new Date(nowMs).toISOString(),
          expiresAt: quote.expiresAt.toISOString(),
          overdueSeconds,
        },
        expected: { quoteStillWithinExpiryWindow: true },
        moneyAtRiskMinor: quote.totalMinor,
        remediation:
          "Re-price the basket and obtain fresh buyer approval once a quote " +
          "expires.",
      });
    }

    // The window the integration actually issued, vs the policy limit.
    const windowMinutes =
      (expiresMs - quote.createdAt.getTime()) / 60_000;
    const allowed = ctx.policy.transaction.quoteExpiryMinutes;
    if (windowMinutes > allowed + 1e-9) {
      return violation({
        message:
          `Quote ${quote.id} was issued with a ${windowMinutes.toFixed(1)}-minute ` +
          `validity window, exceeding the ${allowed}-minute policy limit.`,
        observed: { issuedWindowMinutes: Number(windowMinutes.toFixed(2)) },
        expected: { quoteExpiryMinutes: allowed },
        moneyAtRiskMinor: quote.totalMinor,
        severity: "high",
        remediation:
          "Derive quote expiry from the policy rather than hard-coding it.",
      });
    }

    return pass(
      `Quote valid for a further ${Math.round((expiresMs - nowMs) / 1000)}s`,
    );
  },
};
