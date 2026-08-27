import type { Clock } from "../core/clock.js";
import { minutesFrom } from "../core/clock.js";
import { type IdFactory, randomId, stableHash } from "../core/ids.js";
import { type Minor, formatMinor } from "../core/money.js";
import { quoteContentHash } from "../core/quoteHash.js";
import type {
  ApprovalReceipt,
  CheckoutIntent,
  Order,
  PaymentAttempt,
  Product,
  Quote,
  QuoteLineItem,
} from "../core/types.js";
import type { PaymentProvider } from "../payments/provider.js";
import { PaymentProviderError } from "../payments/provider.js";
import type { Policy } from "../policy/schema.js";
import type { MutationSet } from "./mutations.js";
import { type PricingLine, computePricing } from "./pricing.js";
import type { MerchantState } from "./state.js";

export interface Bundle {
  id: string;
  intentId: string;
  items: Array<{ productId: string; quantity: number }>;
  promoCodes: string[];
  createdAt: Date;
}

export type CommerceErrorCode =
  | "unknown_product"
  | "not_bundle_eligible"
  | "bundles_disabled"
  | "out_of_stock"
  | "unknown_bundle"
  | "unknown_quote"
  | "unknown_approval"
  | "unknown_checkout"
  | "unknown_payment"
  | "quote_expired"
  | "amount_mismatch"
  | "price_changed"
  | "confirmation_required"
  | "payment_not_captured"
  | "duplicate_authorization"
  | "amount_above_ceiling"
  | "empty_bundle";

/**
 * A rejection by the merchant's own code.
 *
 * These are *good* outcomes when they happen for the right reason — the
 * integration caught its own problem. AgentProof counts them as "safely
 * rejected" rather than violations.
 */
export class CommerceError extends Error {
  constructor(
    readonly code: CommerceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CommerceError";
  }
}

export interface SearchFilters {
  query?: string;
  category?: string;
  maxPriceMinor?: Minor;
  requireVegan?: boolean;
  excludeAllergens?: string[];
}

/**
 * HamperHub: the merchant integration under test.
 *
 * This class is the *subject*, not part of AgentProof's engine. It contains
 * realistic bugs toggled by `MutationSet`. Nothing here imports the invariant
 * library, and the Guard has no knowledge of which mutations are active — the
 * two only meet through the domain objects.
 */
export class HamperHubService {
  private bundles = new Map<string, Bundle>();
  private quotes = new Map<string, Quote>();
  private approvals = new Map<string, ApprovalReceipt>();
  private checkouts = new Map<string, CheckoutIntent>();
  private payments = new Map<string, PaymentAttempt>();
  private orders = new Map<string, Order>();
  /** Authorization attempts per checkout intent, for retry reconciliation. */
  private authorizeAttempts = new Map<string, number>();

  constructor(
    private readonly deps: {
      clock: Clock;
      ids: IdFactory;
      state: MerchantState;
      policy: Policy;
      policyVersion: string;
      mutations: MutationSet;
      payments: PaymentProvider;
    },
  ) {}

  // -- tool: search_products ----------------------------------------------

  searchProducts(filters: SearchFilters): Product[] {
    const unknownIsSafe = this.deps.mutations.has("unknown_allergen_safe");
    const needle = filters.query?.trim().toLowerCase();
    const avoid = (filters.excludeAllergens ?? []).map((a) => a.toLowerCase());

    return this.deps.state.listProducts().filter((product) => {
      if (needle) {
        const haystack = `${product.name} ${product.category}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      if (filters.category && product.category !== filters.category) return false;
      if (
        filters.maxPriceMinor !== undefined &&
        product.priceMinor > filters.maxPriceMinor
      ) {
        return false;
      }

      if (filters.requireVegan) {
        // DEFECT (unknown_allergen_safe): null vegan status read as vegan.
        const vegan = unknownIsSafe ? (product.vegan ?? true) : product.vegan;
        if (vegan !== true) return false;
      }

      if (avoid.length > 0) {
        // DEFECT (unknown_allergen_safe): `?? []` turns "we don't know" into
        // "contains nothing", so unknown products survive an allergen filter.
        const allergens = unknownIsSafe
          ? (product.allergens ?? [])
          : product.allergens;
        if (allergens === null) return false;
        if (allergens.some((a) => avoid.includes(a.toLowerCase()))) return false;
      }

      return true;
    });
  }

  // -- tool: create_bundle -------------------------------------------------

  createBundle(input: {
    intentId: string;
    items: Array<{ productId: string; quantity: number }>;
    promoCodes?: string[];
  }): Bundle {
    if (!this.deps.policy.products.bundlesAllowed) {
      throw new CommerceError("bundles_disabled", "Bundles are not permitted");
    }
    if (input.items.length === 0) {
      throw new CommerceError("empty_bundle", "A bundle needs at least one item");
    }

    for (const item of input.items) {
      const product = this.deps.state.getProduct(item.productId);
      if (!product) {
        throw new CommerceError(
          "unknown_product",
          `No such product: ${item.productId}`,
        );
      }
      if (!product.bundleEligible) {
        throw new CommerceError(
          "not_bundle_eligible",
          `${product.name} cannot be included in a bundle`,
        );
      }
    }

    const bundle: Bundle = {
      id: this.deps.ids.next("bundle"),
      intentId: input.intentId,
      items: input.items.map((item) => ({ ...item })),
      promoCodes: (input.promoCodes ?? []).map((c) => c.toUpperCase()),
      createdAt: this.deps.clock.now(),
    };
    this.bundles.set(bundle.id, bundle);
    return bundle;
  }

  // -- tool: create_quote --------------------------------------------------

  createQuote(input: { intentId: string; bundleId: string }): {
    quote: Quote;
    rejectedPromos: Array<{ code: string; reason: string }>;
  } {
    const bundle = this.bundles.get(input.bundleId);
    if (!bundle) {
      throw new CommerceError("unknown_bundle", `No such bundle: ${input.bundleId}`);
    }

    this.deps.state.expireStaleReservations();

    const lineItems: QuoteLineItem[] = [];
    const pricingLines: PricingLine[] = [];

    for (const item of bundle.items) {
      const product = this.deps.state.requireProduct(item.productId);
      const inventory = this.deps.state.requireInventory(item.productId);
      const lineTotal = product.priceMinor * item.quantity;

      lineItems.push({
        productId: product.id,
        name: product.name,
        quantity: item.quantity,
        unitPriceMinor: product.priceMinor,
        lineTotalMinor: lineTotal,
        // Versions captured here are what the Guard compares at checkout.
        priceVersion: product.priceVersion,
        inventoryVersion: inventory.version,
      });
      pricingLines.push({
        productId: product.id,
        quantity: item.quantity,
        unitPriceMinor: product.priceMinor,
        lineTotalMinor: lineTotal,
        minPriceMinor: product.minPriceMinor,
      });
    }

    const pricing = computePricing(
      pricingLines,
      bundle.promoCodes,
      {
        maxDiscountPercent: this.deps.policy.pricing.maximumDiscountPercent,
        allowStacking: this.deps.policy.pricing.allowDiscountStacking,
      },
      this.deps.mutations,
    );

    // DEFECT (missing_quote_expiry): a hard-coded 24h window instead of policy.
    const expiryMinutes = this.deps.mutations.has("missing_quote_expiry")
      ? 24 * 60
      : this.deps.policy.transaction.quoteExpiryMinutes;

    const createdAt = this.deps.clock.now();
    const quote: Quote = {
      id: this.deps.ids.next("quote"),
      version: 1,
      bundleId: bundle.id,
      intentId: input.intentId,
      currency: this.deps.policy.currency,
      lineItems,
      subtotalMinor: pricing.subtotalMinor,
      discounts: pricing.discounts,
      totalDiscountMinor: pricing.totalDiscountMinor,
      totalMinor: pricing.totalMinor,
      policyVersion: this.deps.policyVersion,
      reservationId: null,
      createdAt,
      expiresAt: minutesFrom(this.deps.clock, expiryMinutes),
      status: "active",
    };

    // A competent integration enforces its own per-transaction ceiling rather
    // than relying on a downstream layer to catch it.
    if (quote.totalMinor > this.deps.policy.transaction.maximumAmountMinor) {
      throw new CommerceError(
        "amount_above_ceiling",
        `Quote total ${formatMinor(quote.totalMinor)} exceeds the ` +
          `per-transaction maximum of ` +
          `${formatMinor(this.deps.policy.transaction.maximumAmountMinor)}`,
      );
    }

    if (this.deps.policy.inventory.reserveBeforeCheckout) {
      const reservation = this.deps.state.reserve(
        quote.id,
        bundle.items,
        this.deps.policy.inventory.reservationMinutes,
      );
      if (!reservation) {
        throw new CommerceError(
          "out_of_stock",
          `Cannot reserve stock for bundle ${bundle.id}`,
        );
      }
      quote.reservationId = reservation.id;
    }

    this.quotes.set(quote.id, quote);
    return { quote, rejectedPromos: pricing.rejectedPromos };
  }

  // -- tool: approve_quote -------------------------------------------------

  approveQuote(input: {
    intentId: string;
    quoteId: string;
    approvedAmountMinor: Minor;
    confirmationText: string;
  }): ApprovalReceipt {
    const quote = this.quotes.get(input.quoteId);
    if (!quote) {
      throw new CommerceError("unknown_quote", `No such quote: ${input.quoteId}`);
    }

    if (input.approvedAmountMinor !== quote.totalMinor) {
      throw new CommerceError(
        "amount_mismatch",
        `Buyer approved ${formatMinor(input.approvedAmountMinor)} but the quote ` +
          `total is ${formatMinor(quote.totalMinor)}`,
      );
    }

    const receipt: ApprovalReceipt = {
      id: this.deps.ids.next("appr"),
      quoteId: quote.id,
      // Binding to the version, not just the id, is what makes a later
      // re-price detectable rather than silently inherited.
      quoteVersion: quote.version,
      intentId: input.intentId,
      approvedAmountMinor: input.approvedAmountMinor,
      currency: quote.currency,
      confirmationText: input.confirmationText,
      approvedContentHash: quoteContentHash(quote),
      policyVersion: this.deps.policyVersion,
      createdAt: this.deps.clock.now(),
    };
    this.approvals.set(receipt.id, receipt);
    return receipt;
  }

  // -- tool: create_checkout (phase 1) ------------------------------------

  /**
   * Builds a checkout intent without creating anything payable.
   *
   * Splitting checkout into prepare/authorize is what lets the Guard evaluate a
   * fully-formed intent and still block before money can move. The merchant's
   * own defensive checks live here — and the mutations remove them one by one.
   */
  prepareCheckout(input: {
    intentId: string;
    quoteId: string;
    approvalReceiptId?: string | null;
  }): CheckoutIntent {
    const quote = this.quotes.get(input.quoteId);
    if (!quote) {
      throw new CommerceError("unknown_quote", `No such quote: ${input.quoteId}`);
    }

    const approval = input.approvalReceiptId
      ? this.approvals.get(input.approvalReceiptId)
      : undefined;
    if (input.approvalReceiptId && !approval) {
      throw new CommerceError(
        "unknown_approval",
        `No such approval receipt: ${input.approvalReceiptId}`,
      );
    }

    // DEFECT (missing_buyer_confirmation): checkout proceeds with no receipt.
    if (
      !this.deps.mutations.has("missing_buyer_confirmation") &&
      this.deps.policy.transaction.requireBuyerConfirmation &&
      !approval
    ) {
      throw new CommerceError(
        "confirmation_required",
        "Buyer confirmation is required before checkout",
      );
    }

    // DEFECT (missing_quote_expiry): expiry never consulted.
    if (!this.deps.mutations.has("missing_quote_expiry")) {
      if (this.deps.clock.nowMs() > quote.expiresAt.getTime()) {
        throw new CommerceError(
          "quote_expired",
          `Quote ${quote.id} expired at ${quote.expiresAt.toISOString()}`,
        );
      }
    }

    // DEFECT (missing_price_version_check): stale approval reused after a
    // price change.
    if (!this.deps.mutations.has("missing_price_version_check")) {
      for (const line of quote.lineItems) {
        const product = this.deps.state.getProduct(line.productId);
        if (!product) {
          throw new CommerceError(
            "unknown_product",
            `${line.name} is no longer in the catalog`,
          );
        }
        if (
          product.priceVersion !== line.priceVersion ||
          product.priceMinor !== line.unitPriceMinor
        ) {
          throw new CommerceError(
            "price_changed",
            `${product.name} price changed from ` +
              `${formatMinor(line.unitPriceMinor)} to ` +
              `${formatMinor(product.priceMinor)} after this quote was priced`,
          );
        }
      }
    }

    // DEFECT (missing_inventory_revalidation): stock trusted from quote time.
    if (!this.deps.mutations.has("missing_inventory_revalidation")) {
      this.deps.state.expireStaleReservations();
      const reservation = quote.reservationId
        ? this.deps.state.getReservation(quote.reservationId)
        : undefined;
      const held = new Map<string, number>();
      if (reservation?.status === "held") {
        for (const item of reservation.items) {
          held.set(item.productId, (held.get(item.productId) ?? 0) + item.quantity);
        }
      }
      for (const line of quote.lineItems) {
        const usable =
          this.deps.state.freeStock(line.productId) +
          (held.get(line.productId) ?? 0);
        if (usable < line.quantity) {
          throw new CommerceError(
            "out_of_stock",
            `${line.name}: ${line.quantity} requested but only ${usable} available`,
          );
        }
      }
    }

    // DEFECT (missing_idempotency): a fresh random key per attempt, so a retry
    // looks like a brand-new order to every downstream system.
    const idempotencyKey = this.deps.mutations.has("missing_idempotency")
      ? randomId("idem")
      : `idem_${stableHash({
          intentId: input.intentId,
          quoteId: quote.id,
          quoteVersion: quote.version,
          amountMinor: quote.totalMinor,
        }).slice(0, 24)}`;

    // Correct integrations return the existing order for a repeated key.
    if (!this.deps.mutations.has("missing_idempotency")) {
      const existing = [...this.checkouts.values()].find(
        (intent) =>
          intent.idempotencyKey === idempotencyKey &&
          intent.status !== "blocked" &&
          intent.status !== "failed",
      );
      if (existing) return { ...existing };
    }

    const checkout: CheckoutIntent = {
      id: this.deps.ids.next("chk"),
      intentId: input.intentId,
      quoteId: quote.id,
      quoteVersion: quote.version,
      approvalReceiptId: approval?.id ?? null,
      idempotencyKey,
      amountMinor: quote.totalMinor,
      currency: quote.currency,
      createdAt: this.deps.clock.now(),
      status: "requested",
    };
    this.checkouts.set(checkout.id, checkout);
    return { ...checkout };
  }

  // -- tool: create_checkout (phase 2) ------------------------------------

  /**
   * Creates the payable provider order. Only ever called after the Guard
   * returns `allow` for the `checkout.requested` checkpoint.
   */
  async authorizeCheckout(checkoutIntentId: string): Promise<PaymentAttempt> {
    const checkout = this.checkouts.get(checkoutIntentId);
    if (!checkout) {
      throw new CommerceError(
        "unknown_checkout",
        `No such checkout intent: ${checkoutIntentId}`,
      );
    }

    const priorAttempts = this.authorizeAttempts.get(checkout.id) ?? 0;
    this.authorizeAttempts.set(checkout.id, priorAttempts + 1);

    // A timed-out create-order may well have succeeded at the provider, so a
    // second call is not safe just because the first one threw. A correct
    // integration reconciles instead of retrying blind. Without this, the fixed
    // integration would still open a duplicate order on retry — the idempotency
    // key alone does not help when the provider offers no idempotency header.
    if (priorAttempts > 0 && !this.deps.mutations.has("missing_idempotency")) {
      const existing = [...this.payments.values()].find(
        (p) => p.checkoutIntentId === checkout.id,
      );
      if (existing) return { ...existing };
      throw new CommerceError(
        "duplicate_authorization",
        `Authorization for checkout ${checkout.id} was already attempted and its ` +
          `outcome is unknown. Reconcile with the provider before retrying ` +
          `instead of creating a second order.`,
      );
    }

    try {
      const order = await this.deps.payments.createOrder({
        amountMinor: checkout.amountMinor,
        currency: checkout.currency,
        // Razorpay has no idempotency header on Orders; `receipt` is the only
        // uniqueness handle available, so the Guard's key goes here.
        receipt: checkout.idempotencyKey,
        idempotencyKey: checkout.idempotencyKey,
        notes: {
          intent_id: checkout.intentId,
          quote_id: checkout.quoteId,
        },
      });

      const attempt: PaymentAttempt = {
        id: this.deps.ids.next("pa"),
        checkoutIntentId: checkout.id,
        providerOrderId: order.orderId,
        providerPaymentId: null,
        amountMinor: order.amountMinor,
        currency: order.currency,
        status: "created",
        createdAt: this.deps.clock.now(),
        verified: false,
        hostedUrl: order.hostedUrl ?? null,
      };
      this.payments.set(attempt.id, attempt);
      checkout.status = "authorized";
      return { ...attempt };
    } catch (error) {
      if (error instanceof PaymentProviderError && error.kind === "timeout") {
        // Deliberately leave the intent payable. The provider may well have
        // created the order; pretending otherwise is how double charges happen.
        throw error;
      }
      checkout.status = "failed";
      throw error;
    }
  }

  // -- tool: get_payment_status -------------------------------------------

  async verifyPayment(paymentAttemptId: string): Promise<PaymentAttempt> {
    const attempt = this.payments.get(paymentAttemptId);
    if (!attempt) {
      throw new CommerceError(
        "unknown_payment",
        `No such payment attempt: ${paymentAttemptId}`,
      );
    }

    const providerPayments = await this.deps.payments.fetchOrderPayments(
      attempt.providerOrderId,
    );
    const captured = providerPayments.find((p) => p.status === "captured");
    const chosen = captured ?? providerPayments[0];

    if (chosen) {
      attempt.providerPaymentId = chosen.paymentId;
      attempt.status = chosen.status;
      // Verified means: re-read from the provider AND amount/currency matched.
      attempt.verified =
        chosen.amountMinor === attempt.amountMinor &&
        chosen.currency === attempt.currency;
    }
    return { ...attempt };
  }

  /**
   * Dry-run of the integration's own fulfilment checks.
   *
   * Lets the Guard distinguish "the merchant would have caught this" from "only
   * the Guard caught this" without risking an actual fulfilment. Without this
   * the Guard blocks first and a correct integration would be blamed for a
   * defect it does not have.
   */
  wouldFulfil(checkoutIntentId: string): { ok: boolean; reason: string | null } {
    const checkout = this.checkouts.get(checkoutIntentId);
    if (!checkout) return { ok: false, reason: "unknown checkout intent" };
    const attempt = [...this.payments.values()].find(
      (p) => p.checkoutIntentId === checkoutIntentId,
    );
    if (!attempt) return { ok: false, reason: "no payment attempt" };

    if (this.deps.mutations.has("incorrect_payment_state")) {
      return { ok: true, reason: null };
    }
    if (attempt.status !== "captured" || !attempt.verified) {
      return {
        ok: false,
        reason:
          `payment is '${attempt.status}' (verified=${attempt.verified})`,
      };
    }
    return { ok: true, reason: null };
  }

  fulfillOrder(checkoutIntentId: string): Order {
    const checkout = this.checkouts.get(checkoutIntentId);
    if (!checkout) {
      throw new CommerceError(
        "unknown_checkout",
        `No such checkout intent: ${checkoutIntentId}`,
      );
    }
    const attempt = [...this.payments.values()].find(
      (p) => p.checkoutIntentId === checkoutIntentId,
    );
    if (!attempt) {
      throw new CommerceError(
        "unknown_payment",
        `No payment attempt for checkout ${checkoutIntentId}`,
      );
    }

    // DEFECT (incorrect_payment_state): fulfil without a captured payment.
    if (!this.deps.mutations.has("incorrect_payment_state")) {
      if (attempt.status !== "captured" || !attempt.verified) {
        throw new CommerceError(
          "payment_not_captured",
          `Payment ${attempt.id} is '${attempt.status}' ` +
            `(verified=${attempt.verified}); refusing to fulfil the order`,
        );
      }
    }

    const order: Order = {
      id: this.deps.ids.next("ord"),
      checkoutIntentId: checkout.id,
      paymentAttemptId: attempt.id,
      amountMinor: attempt.amountMinor,
      currency: attempt.currency,
      status: "confirmed",
      createdAt: this.deps.clock.now(),
    };
    this.orders.set(order.id, order);
    checkout.status = "fulfilled";

    const quote = this.quotes.get(checkout.quoteId);
    if (quote?.reservationId) {
      this.deps.state.commitReservation(quote.reservationId);
      quote.status = "consumed";
    }
    return order;
  }

  // -- state used by the Guard --------------------------------------------

  markCheckoutBlocked(checkoutIntentId: string): void {
    const checkout = this.checkouts.get(checkoutIntentId);
    if (checkout) checkout.status = "blocked";
  }

  releaseQuoteReservation(quoteId: string): boolean {
    const quote = this.quotes.get(quoteId);
    if (!quote?.reservationId) return false;
    return this.deps.state.releaseReservation(quote.reservationId);
  }

  getBundle(id: string): Bundle | undefined {
    const bundle = this.bundles.get(id);
    return bundle ? { ...bundle } : undefined;
  }

  getQuote(id: string): Quote | undefined {
    const quote = this.quotes.get(id);
    return quote ? { ...quote } : undefined;
  }

  getApproval(id: string): ApprovalReceipt | undefined {
    const approval = this.approvals.get(id);
    return approval ? { ...approval } : undefined;
  }

  getCheckoutIntent(id: string): CheckoutIntent | undefined {
    const checkout = this.checkouts.get(id);
    return checkout ? { ...checkout } : undefined;
  }

  listCheckoutIntents(intentId?: string): CheckoutIntent[] {
    const all = [...this.checkouts.values()].map((c) => ({ ...c }));
    return intentId ? all.filter((c) => c.intentId === intentId) : all;
  }

  getPaymentAttempt(id: string): PaymentAttempt | undefined {
    const attempt = this.payments.get(id);
    return attempt ? { ...attempt } : undefined;
  }

  listPaymentAttempts(): PaymentAttempt[] {
    return [...this.payments.values()].map((p) => ({ ...p }));
  }

  findPaymentAttemptForCheckout(
    checkoutIntentId: string,
  ): PaymentAttempt | undefined {
    const attempt = [...this.payments.values()].find(
      (p) => p.checkoutIntentId === checkoutIntentId,
    );
    return attempt ? { ...attempt } : undefined;
  }

  listOrders(): Order[] {
    return [...this.orders.values()].map((o) => ({ ...o }));
  }
}
