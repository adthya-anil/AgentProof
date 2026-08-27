import { formatMinor } from "../../core/money.js";
import { type Invariant, pass, skip, violation } from "./types.js";

const PAYABLE_STATUSES = new Set(["requested", "authorized", "fulfilled"]);

/**
 * One buyer intent yields at most one payable order.
 *
 * Agents retry. A timeout on payment creation is indistinguishable, from the
 * agent's side, from a failure — so it will try again. Without a key derived
 * from the *content* of the request, that retry opens a second payable order and
 * the buyer can be charged twice.
 *
 * Two checks run here: duplicate idempotency keys (the same request twice) and,
 * when policy says one payment per intent, any second payable order for the
 * same intent even under a different key.
 */
export const idempotencyInvariant: Invariant = {
  id: "INV-IDEMPOTENCY",
  title: "A single checkout intent cannot create multiple payable orders",
  severity: "critical",
  policyRefs: ["transaction.one_payment_per_intent"],
  attribution: "integration",
  appliesAt: ["checkout.requested"],
  evaluate(ctx) {
    const checkout = ctx.checkoutIntent;
    if (!checkout) return skip("No checkout in flight");

    const priors = (ctx.priorCheckoutIntents ?? []).filter(
      (prior) => prior.id !== checkout.id,
    );

    // Same content, charged twice.
    const keyCollisions = priors.filter(
      (prior) =>
        prior.idempotencyKey === checkout.idempotencyKey &&
        PAYABLE_STATUSES.has(prior.status),
    );

    if (keyCollisions.length > 0) {
      const duplicated = keyCollisions.map((prior) => ({
        checkoutIntentId: prior.id,
        status: prior.status,
        amountMinor: prior.amountMinor,
      }));
      return violation({
        message:
          `Duplicate checkout: idempotency key ${checkout.idempotencyKey} ` +
          `already produced ${keyCollisions.length} payable order(s) ` +
          `(${keyCollisions.map((p) => p.id).join(", ")}). Creating another ` +
          `would charge the buyer ${formatMinor(checkout.amountMinor)} twice for ` +
          `the same basket.`,
        observed: {
          idempotencyKey: checkout.idempotencyKey,
          existingPayableOrders: duplicated,
        },
        expected: { payableOrdersPerIdempotencyKey: 1 },
        moneyAtRiskMinor: checkout.amountMinor,
        remediation:
          "Derive an idempotency key from intent + quote version + amount and " +
          "return the existing order when the key repeats.",
      });
    }

    // Different key, same buyer intent.
    if (ctx.policy.transaction.onePaymentPerIntent) {
      const otherPayable = priors.filter(
        (prior) =>
          prior.intentId === checkout.intentId &&
          PAYABLE_STATUSES.has(prior.status),
      );
      if (otherPayable.length > 0) {
        return violation({
          message:
            `Buyer intent ${checkout.intentId} already has ` +
            `${otherPayable.length} payable order(s) ` +
            `(${otherPayable.map((p) => p.id).join(", ")}), but policy permits ` +
            `one payment per intent. A retry created a second payable order ` +
            `under a different idempotency key.`,
          observed: {
            intentId: checkout.intentId,
            existingPayableOrders: otherPayable.map((p) => ({
              checkoutIntentId: p.id,
              idempotencyKey: p.idempotencyKey,
              status: p.status,
              amountMinor: p.amountMinor,
            })),
            newIdempotencyKey: checkout.idempotencyKey,
          },
          expected: { payableOrdersPerIntent: 1 },
          moneyAtRiskMinor: checkout.amountMinor,
          remediation:
            "Make the idempotency key a deterministic function of the buyer " +
            "intent and basket, not a fresh random value per attempt.",
        });
      }
    }

    return pass("No duplicate payable order for this intent");
  },
};
