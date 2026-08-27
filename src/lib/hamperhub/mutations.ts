/**
 * Seeded defects in the HamperHub *integration* (§8, §17).
 *
 * Critical design rule: mutations only ever change how the merchant's own
 * commerce code behaves. They never touch the Guard or the invariant library.
 * That separation is what makes the evaluation honest — the scenario generator
 * is not told which mutation is active, and the Guard has no special case for
 * any of them. It catches them because the invariants are independent checks,
 * not because we wired a hint through.
 */
export const MUTATIONS = {
  discount_stacking: {
    id: "discount_stacking",
    title: "Discounts validated individually instead of cumulatively",
    description:
      "Each discount component is checked against the 5% cap on its own. " +
      "Applied sequentially, 4% + 4.9% yields an 8.7% effective discount.",
    expectedInvariant: "INV-DISCOUNT-CAP",
  },
  missing_quote_expiry: {
    id: "missing_quote_expiry",
    title: "Quote expiry never enforced",
    description:
      "Checkout accepts a quote regardless of how long ago it was priced.",
    expectedInvariant: "INV-QUOTE-EXPIRY",
  },
  missing_price_version_check: {
    id: "missing_price_version_check",
    title: "Approval not rebound after a price change",
    description:
      "The buyer approved one amount; a later price change is not detected and " +
      "the stale approval is reused at checkout.",
    expectedInvariant: "INV-PRICE-BINDING",
  },
  missing_inventory_revalidation: {
    id: "missing_inventory_revalidation",
    title: "Inventory not revalidated before checkout",
    description:
      "Availability is checked once at quote time and trusted thereafter.",
    expectedInvariant: "INV-INVENTORY",
  },
  missing_buyer_confirmation: {
    id: "missing_buyer_confirmation",
    title: "Conversational reply treated as payment approval",
    description:
      "Checkout proceeds without an approval receipt bound to the exact quote.",
    expectedInvariant: "INV-CONFIRMATION",
  },
  missing_idempotency: {
    id: "missing_idempotency",
    title: "Retries create duplicate payable orders",
    description:
      "No effective idempotency key, so an agent retry after a timeout opens a " +
      "second payable order for the same buyer intent.",
    expectedInvariant: "INV-IDEMPOTENCY",
  },
  incorrect_payment_state: {
    id: "incorrect_payment_state",
    title: "Order fulfilled before payment is captured",
    description:
      "Merchant order is confirmed on order creation rather than on verified " +
      "payment capture.",
    expectedInvariant: "INV-PAYMENT-STATE",
  },
  unknown_allergen_safe: {
    id: "unknown_allergen_safe",
    title: "Missing allergen data treated as allergen-free",
    description:
      "A null allergen field is read as an empty list, so a product with " +
      "unknown ingredients is offered to an allergic buyer.",
    expectedInvariant: "INV-PRODUCT-SAFETY",
  },
} as const;

export type MutationId = keyof typeof MUTATIONS;

export const MUTATION_IDS = Object.keys(MUTATIONS) as MutationId[];

export interface MutationDescriptor {
  id: MutationId;
  title: string;
  description: string;
  /** The invariant expected to fire. Used to score detection, not to trigger it. */
  expectedInvariant: string;
}

export function describeMutation(id: MutationId): MutationDescriptor {
  return MUTATIONS[id] as MutationDescriptor;
}

/**
 * Which defects are active in the integration under test.
 *
 * `vulnerable()` reproduces the four demo defects from §8; `fixed()` is the
 * repaired integration the developer ships after reading the report.
 */
export class MutationSet {
  private readonly active: Set<MutationId>;

  constructor(active: Iterable<MutationId> = []) {
    this.active = new Set(active);
  }

  static fixed(): MutationSet {
    return new MutationSet([]);
  }

  /** The four headline defects demonstrated in the pitch. */
  static vulnerable(): MutationSet {
    return new MutationSet([
      "discount_stacking",
      "missing_price_version_check",
      "missing_idempotency",
      "unknown_allergen_safe",
    ]);
  }

  static only(id: MutationId): MutationSet {
    return new MutationSet([id]);
  }

  has(id: MutationId): boolean {
    return this.active.has(id);
  }

  list(): MutationId[] {
    return MUTATION_IDS.filter((id) => this.active.has(id));
  }

  get size(): number {
    return this.active.size;
  }
}
