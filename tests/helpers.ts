import { ManualClock } from "../src/lib/core/clock.js";
import { IdFactory } from "../src/lib/core/ids.js";
import { type Minor, rupees } from "../src/lib/core/money.js";
import { quoteContentHash } from "../src/lib/core/quoteHash.js";
import type {
  ApprovalReceipt,
  BuyerIntent,
  CheckoutIntent,
  DiscountComponent,
  PaymentAttempt,
  Quote,
  QuoteLineItem,
} from "../src/lib/core/types.js";
import { MerchantState } from "../src/lib/hamperhub/state.js";
import { loadPolicyFromYaml, policyVersion } from "../src/lib/policy/load.js";
import type { Policy } from "../src/lib/policy/schema.js";
import type { EvaluationContext } from "../src/lib/policy/invariants/types.js";

export const POLICY_YAML = `
policy_id: test-v1
currency: INR
transaction:
  maximum_amount: 5000
  quote_expiry_minutes: 10
  require_buyer_confirmation: true
  one_payment_per_intent: true
pricing:
  maximum_discount_percent: 5
  allow_discount_stacking: false
  payment_must_equal_approved_quote: true
  enforce_floor_price: true
inventory:
  require_current_availability: true
  reserve_before_checkout: true
  reservation_minutes: 10
products:
  bundles_allowed: true
  unknown_allergen_status: escalate
  substitutions_require_approval: true
`;

export interface Fixture {
  clock: ManualClock;
  ids: IdFactory;
  state: MerchantState;
  policy: Policy;
  policyVersion: string;
  intent: BuyerIntent;
}

export function fixture(overrides: Partial<Policy> = {}): Fixture {
  const clock = new ManualClock(new Date("2026-03-01T10:00:00.000Z"));
  const ids = new IdFactory("test");
  const state = new MerchantState(clock, ids);
  const policy = { ...loadPolicyFromYaml(POLICY_YAML), ...overrides };
  return {
    clock,
    ids,
    state,
    policy,
    policyVersion: policyVersion(policy),
    intent: {
      id: "intent_test",
      runId: "run_test",
      utterance: "test",
      constraints: {
        maxBudgetMinor: null,
        requireVegan: false,
        mustAvoidAllergens: [],
        occasion: null,
        themes: [],
      },
      createdAt: clock.now(),
    },
  };
}

/** Builds a quote from live catalog prices, so versions line up by default. */
export function buildQuote(
  f: Fixture,
  items: Array<{ productId: string; quantity: number }>,
  opts: {
    discounts?: DiscountComponent[];
    expiryMinutes?: number;
    reserve?: boolean;
    version?: number;
  } = {},
): Quote {
  const lineItems: QuoteLineItem[] = items.map((item) => {
    const product = f.state.requireProduct(item.productId);
    const inventory = f.state.requireInventory(item.productId);
    return {
      productId: product.id,
      name: product.name,
      quantity: item.quantity,
      unitPriceMinor: product.priceMinor,
      lineTotalMinor: product.priceMinor * item.quantity,
      priceVersion: product.priceVersion,
      inventoryVersion: inventory.version,
    };
  });

  const subtotalMinor = lineItems.reduce((s, l) => s + l.lineTotalMinor, 0);
  const discounts = opts.discounts ?? [];
  const totalDiscountMinor = discounts.reduce((s, d) => s + d.amountMinor, 0);
  const expiryMinutes = opts.expiryMinutes ?? f.policy.transaction.quoteExpiryMinutes;

  const quote: Quote = {
    id: "quote_test",
    version: opts.version ?? 1,
    bundleId: "bundle_test",
    intentId: f.intent.id,
    currency: "INR",
    lineItems,
    subtotalMinor,
    discounts,
    totalDiscountMinor,
    totalMinor: subtotalMinor - totalDiscountMinor,
    policyVersion: f.policyVersion,
    reservationId: null,
    createdAt: f.clock.now(),
    expiresAt: new Date(f.clock.nowMs() + expiryMinutes * 60_000),
    status: "active",
  };

  if (opts.reserve !== false) {
    const reservation = f.state.reserve(
      quote.id,
      items,
      f.policy.inventory.reservationMinutes,
    );
    quote.reservationId = reservation?.id ?? null;
  }
  return quote;
}

export function buildApproval(
  f: Fixture,
  quote: Quote,
  overrides: Partial<ApprovalReceipt> = {},
): ApprovalReceipt {
  return {
    id: "appr_test",
    quoteId: quote.id,
    quoteVersion: quote.version,
    intentId: f.intent.id,
    approvedAmountMinor: quote.totalMinor,
    currency: "INR",
    confirmationText: "Yes, charge me.",
    approvedContentHash: quoteContentHash(quote),
    policyVersion: f.policyVersion,
    createdAt: f.clock.now(),
    ...overrides,
  };
}

export function buildCheckout(
  f: Fixture,
  quote: Quote,
  overrides: Partial<CheckoutIntent> = {},
): CheckoutIntent {
  return {
    id: "chk_test",
    intentId: f.intent.id,
    quoteId: quote.id,
    quoteVersion: quote.version,
    approvalReceiptId: "appr_test",
    idempotencyKey: "idem_test",
    amountMinor: quote.totalMinor,
    currency: "INR",
    createdAt: f.clock.now(),
    status: "requested",
    ...overrides,
  };
}

export function buildPayment(
  f: Fixture,
  amountMinor: Minor,
  overrides: Partial<PaymentAttempt> = {},
): PaymentAttempt {
  return {
    id: "pa_test",
    checkoutIntentId: "chk_test",
    providerOrderId: "order_test",
    providerPaymentId: "pay_test",
    amountMinor,
    currency: "INR",
    status: "captured",
    createdAt: f.clock.now(),
    verified: true,
    ...overrides,
  };
}

export function ctx(
  f: Fixture,
  parts: Partial<EvaluationContext> & Pick<EvaluationContext, "checkpoint">,
): EvaluationContext {
  return {
    policy: f.policy,
    policyVersion: f.policyVersion,
    clock: f.clock,
    catalog: f.state,
    intent: f.intent,
    quote: null,
    approval: null,
    checkoutIntent: null,
    paymentAttempt: null,
    priorCheckoutIntents: [],
    ...parts,
  };
}

export function pct(
  code: string,
  percent: number,
  appliedToMinor: Minor,
): DiscountComponent {
  return {
    code,
    label: code,
    kind: code === "LOYAL49" ? "loyalty" : "bundle",
    percent,
    amountMinor: Math.round((appliedToMinor * percent) / 100),
    appliedToMinor,
  };
}

export { rupees };
