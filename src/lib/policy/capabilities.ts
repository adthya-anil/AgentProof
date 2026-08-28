/**
 * What an invariant needs from a merchant, declared rather than assumed.
 *
 * Every invariant currently reads `EvaluationContext` as though every field were
 * always there, which is true for exactly one merchant. HamperHub is built to the
 * spec's entity model: products carry a `priceVersion`, inventory records carry a
 * `version`, allergens are tri-state. Almost no real catalogue API exposes any of
 * those. Shopify has no price version; a typical GraphQL storefront gives you stock as
 * a boolean; allergens, when they exist at all, are prose in a description field.
 *
 * That leaves three ways to run the Guard against a merchant that cannot supply a
 * field, and only one of them is honest:
 *
 *   1. Let the invariant read `undefined` and pass. This is the dangerous option. A
 *      report would claim 12/12 rules green while the price-binding rule compared
 *      `undefined` to `undefined` and found them equal. Silent false assurance about
 *      money is the exact failure this product exists to prevent.
 *   2. Refuse to run at all without every field. Correct but useless — it would mean
 *      the Guard only works against merchants rebuilt to AgentProof's data model.
 *   3. Declare the requirement, skip when it is unmet, and say so in the report.
 *
 * This is option three. An invariant lists the capabilities it depends on; a merchant
 * declares what it can supply; the engine refuses to run a rule whose inputs are
 * absent and records *why*. "11 of 12 rules ran; INV-PRICE-BINDING did not, because
 * this merchant exposes no product price version" is a true statement a merchant can
 * act on. "12/12 passed" would not have been.
 *
 * The distinction from an ordinary skip matters and is kept explicit. A payment-state
 * rule skipping at quote time has nothing to say yet — that is coverage working. A
 * rule skipping because the data does not exist is a permanent hole in coverage. Both
 * are `skipped`; conflating them would let a merchant read a full green board while
 * three rules never executed at any checkpoint.
 */

/**
 * The capabilities invariants actually depend on.
 *
 * Deliberately short. Each entry earns its place by being (a) genuinely absent from
 * some real merchant API and (b) genuinely required by an invariant here — verified
 * against what the invariant sources read, not guessed at. Everything else in
 * `EvaluationContext` is a construct the Guard itself creates (quotes, approvals,
 * checkout intents, payment attempts), which any adapter must produce to participate at
 * all and so is not optional.
 */
export const CAPABILITY_DESCRIPTIONS = {
  "product.lookup": "a product can be re-read by id at evaluation time",
  "product.priceVersion":
    "a product carries a version or etag that changes when its price changes",
  "product.allergens": "a product declares its allergens explicitly",
  "product.vegan": "a product declares whether it is vegan explicitly",
  "inventory.available": "free stock for a product is readable as a count",
  "inventory.version":
    "an inventory record carries a version that changes when stock changes",
  "reservation.lookup": "a stock reservation can be re-read by id",
  "approval.contentHash":
    "a buyer approval binds to a hash of the quote content it approved",
} as const;

export type Capability = keyof typeof CAPABILITY_DESCRIPTIONS;

export const CAPABILITIES = Object.keys(CAPABILITY_DESCRIPTIONS) as Capability[];

/** Prose for a missing capability, for reports read by people. */
export function describeCapability(capability: Capability): string {
  return CAPABILITY_DESCRIPTIONS[capability];
}

/**
 * What one merchant integration can supply.
 *
 * A set rather than a bag of booleans so that adding a capability cannot silently
 * default to `false` in some adapters and `undefined` in others.
 */
export class CapabilitySet {
  private readonly present: ReadonlySet<Capability>;

  private constructor(capabilities: Iterable<Capability>) {
    this.present = new Set(capabilities);
  }

  /** Everything — a merchant built to the spec's entity model, i.e. HamperHub. */
  static full(): CapabilitySet {
    return new CapabilitySet(CAPABILITIES);
  }

  static of(capabilities: readonly Capability[]): CapabilitySet {
    return new CapabilitySet(capabilities);
  }

  /**
   * Nothing. Exists for tests that need to prove a rule genuinely stops running
   * rather than quietly passing.
   */
  static none(): CapabilitySet {
    return new CapabilitySet([]);
  }

  has(capability: Capability): boolean {
    return this.present.has(capability);
  }

  /** The subset of `required` this merchant cannot supply, in declaration order. */
  missing(required: readonly Capability[]): Capability[] {
    return required.filter((capability) => !this.present.has(capability));
  }

  get declared(): Capability[] {
    return CAPABILITIES.filter((capability) => this.present.has(capability));
  }

  get size(): number {
    return this.present.size;
  }
}
