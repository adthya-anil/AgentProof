import type { Currency, Minor } from "./money.js";

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export type ProductCategory =
  | "coffee"
  | "tea"
  | "chocolate"
  | "candle"
  | "mug"
  | "card"
  | "snack"
  | "packaging";

/**
 * Allergen and vegan data are deliberately tri-state.
 *
 * `null` means "the merchant has not supplied this data" and is NOT the same as
 * `[]` ("verified free of allergens") or `false`. Collapsing unknown into safe
 * is seeded defect #4, so the type system keeps the distinction alive.
 */
export interface Product {
  id: string;
  name: string;
  category: ProductCategory;
  /** Current list price. Mutable at runtime: prices move mid-journey. */
  priceMinor: Minor;
  /** Monotonic counter bumped on every price change. Bound into quotes. */
  priceVersion: number;
  allergens: string[] | null;
  vegan: boolean | null;
  bundleEligible: boolean;
  /** Floor below which the merchant will not sell, after all discounts. */
  minPriceMinor: Minor;
}

export interface InventoryRecord {
  productId: string;
  available: number;
  reserved: number;
  /** Monotonic counter bumped on every stock change. Bound into quotes. */
  version: number;
}

export interface Reservation {
  id: string;
  quoteId: string;
  items: Array<{ productId: string; quantity: number }>;
  expiresAt: Date;
  status: "held" | "committed" | "released";
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export type DiscountKind = "bundle" | "loyalty" | "promo";

export interface DiscountComponent {
  code: string;
  label: string;
  kind: DiscountKind;
  /** Percent discounts record the rate; flat credits record 0. */
  percent: number;
  /** The actual money removed by this component, after rounding. */
  amountMinor: Minor;
  /** The base this component was applied to. Reveals sequential stacking. */
  appliedToMinor: Minor;
}

export interface QuoteLineItem {
  productId: string;
  name: string;
  quantity: number;
  unitPriceMinor: Minor;
  lineTotalMinor: Minor;
  /** Price version at quote time. Compared against live catalog at checkout. */
  priceVersion: number;
  /** Inventory version at quote time. Compared against live stock. */
  inventoryVersion: number;
}

// ---------------------------------------------------------------------------
// Quote / approval / checkout
// ---------------------------------------------------------------------------

export interface Quote {
  id: string;
  /** Bumped when a quote is re-priced. Approvals bind to an exact version. */
  version: number;
  bundleId: string;
  intentId: string;
  currency: Currency;
  lineItems: QuoteLineItem[];
  subtotalMinor: Minor;
  discounts: DiscountComponent[];
  totalDiscountMinor: Minor;
  totalMinor: Minor;
  /** Policy version in force when this quote was priced. */
  policyVersion: string;
  reservationId: string | null;
  createdAt: Date;
  expiresAt: Date;
  status: "active" | "superseded" | "consumed";
}

/**
 * Proof that a human approved one exact quote for one exact amount.
 *
 * The receipt stores the amount and quote version independently of the quote
 * row so that a later re-price cannot silently make an old approval look valid.
 */
export interface ApprovalReceipt {
  id: string;
  quoteId: string;
  quoteVersion: number;
  intentId: string;
  approvedAmountMinor: Minor;
  currency: Currency;
  /** Verbatim buyer utterance that constituted consent. */
  confirmationText: string;
  /** Hash of the exact line items shown to the buyer at approval time. */
  approvedContentHash: string;
  policyVersion: string;
  createdAt: Date;
}

export interface CheckoutIntent {
  id: string;
  intentId: string;
  quoteId: string;
  quoteVersion: number;
  approvalReceiptId: string | null;
  /** One payable order per key. Derived from intent + quote + amount. */
  idempotencyKey: string;
  amountMinor: Minor;
  currency: Currency;
  createdAt: Date;
  status: "requested" | "blocked" | "authorized" | "fulfilled" | "failed";
}

export type PaymentStatus =
  | "created"
  | "authorized"
  | "captured"
  | "failed"
  | "pending";

export interface PaymentAttempt {
  id: string;
  checkoutIntentId: string;
  providerOrderId: string;
  providerPaymentId: string | null;
  amountMinor: Minor;
  currency: Currency;
  status: PaymentStatus;
  createdAt: Date;
  /** True once the provider's own record has been re-read and matched. */
  verified: boolean;
}

export interface Order {
  id: string;
  checkoutIntentId: string;
  paymentAttemptId: string;
  amountMinor: Minor;
  currency: Currency;
  status: "confirmed" | "cancelled";
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Buyer intent
// ---------------------------------------------------------------------------

/**
 * Constraints the buyer stated in natural language, extracted into a structured
 * form the deterministic engine can actually check. `mustAvoidAllergens` is what
 * turns "I have a peanut allergy" into a machine-verifiable safety invariant.
 */
export interface BuyerIntent {
  id: string;
  runId: string;
  utterance: string;
  constraints: {
    maxBudgetMinor: Minor | null;
    requireVegan: boolean;
    mustAvoidAllergens: string[];
    occasion: string | null;
    themes: string[];
  };
  createdAt: Date;
}
