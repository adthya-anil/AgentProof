import { budgetInvariant, maxAmountInvariant } from "./amount.js";
import { confirmationInvariant } from "./confirmation.js";
import { currencyInvariant } from "./currency.js";
import { discountCapInvariant, floorPriceInvariant } from "./discount.js";
import { quoteExpiryInvariant } from "./expiry.js";
import { idempotencyInvariant } from "./idempotency.js";
import { inventoryInvariant } from "./inventory.js";
import { paymentStateInvariant } from "./payment.js";
import { priceBindingInvariant } from "./price.js";
import { productSafetyInvariant } from "./safety.js";
import type { Checkpoint, Invariant } from "./types.js";

/**
 * The complete deterministic rule set.
 *
 * Nothing in this list consults an LLM, and none of it knows which seeded defect
 * is active. Verdicts are arithmetic.
 */
export const ALL_INVARIANTS: readonly Invariant[] = Object.freeze([
  maxAmountInvariant,
  budgetInvariant,
  discountCapInvariant,
  floorPriceInvariant,
  priceBindingInvariant,
  inventoryInvariant,
  confirmationInvariant,
  idempotencyInvariant,
  quoteExpiryInvariant,
  productSafetyInvariant,
  paymentStateInvariant,
  currencyInvariant,
]);

export function invariantsFor(checkpoint: Checkpoint): Invariant[] {
  return ALL_INVARIANTS.filter((inv) => inv.appliesAt.includes(checkpoint));
}

export function invariantById(id: string): Invariant | undefined {
  return ALL_INVARIANTS.find((inv) => inv.id === id);
}

export * from "./types.js";
export {
  budgetInvariant,
  confirmationInvariant,
  currencyInvariant,
  discountCapInvariant,
  floorPriceInvariant,
  idempotencyInvariant,
  inventoryInvariant,
  maxAmountInvariant,
  paymentStateInvariant,
  priceBindingInvariant,
  productSafetyInvariant,
  quoteExpiryInvariant,
};
