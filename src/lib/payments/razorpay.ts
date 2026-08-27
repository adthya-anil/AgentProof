import type { Currency, Minor } from "../core/money.js";
import type { PaymentStatus } from "../core/types.js";
import {
  type CreateOrderParams,
  type PaymentProvider,
  PaymentProviderError,
  type ProviderOrder,
  type ProviderPayment,
} from "./provider.js";

const API_BASE = "https://api.razorpay.com/v1";

/** Razorpay's `receipt` field is capped at 40 characters and must be unique. */
const RECEIPT_MAX_LENGTH = 40;

/**
 * How a payable artefact is created.
 *
 * `order` is the canonical Orders API flow. `payment_link` creates a hosted
 * Razorpay payment page instead, which is the only way to complete a real test
 * payment when there is no browser front end to run Razorpay Checkout. Either
 * way the artefact is created *only* after the Guard has allowed the checkout,
 * so the policy guarantee is identical.
 */
export type CollectionMode = "order" | "payment_link";

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  timeoutMs?: number;
  collectionMode?: CollectionMode;
}

/**
 * Razorpay test-mode adapter.
 *
 * Worth stating plainly, because it is the crux of the product: the Orders API
 * exposes **no** idempotency header. Razorpay offers `X-Payout-Idempotency` and
 * `X-Refund-Idempotency`, but order creation has neither. The only duplicate
 * defence is that `receipt` must be unique — and enforcing that is the
 * merchant's responsibility.
 *
 * So a buyer agent that retries a timed-out checkout will open a second payable
 * order unless the integration derives a stable receipt and refuses to reuse it.
 * AgentProof passes the Guard's idempotency key through as `receipt`, and
 * INV-IDEMPOTENCY blocks the second attempt before this adapter is ever called.
 *
 * Only ever point this at `rzp_test_` credentials.
 */
export class RazorpayProvider implements PaymentProvider {
  readonly name = "razorpay";
  readonly isReal = true;

  private readonly authHeader: string;
  private readonly timeoutMs: number;
  private readonly collectionMode: CollectionMode;

  constructor(private readonly config: RazorpayConfig) {
    if (!config.keyId || !config.keySecret) {
      throw new PaymentProviderError(
        "Razorpay key id and secret are required",
        "config",
        false,
      );
    }
    if (!config.keyId.startsWith("rzp_test_")) {
      throw new PaymentProviderError(
        `Refusing to run AgentProof against non-test credentials ` +
          `(key id must start with "rzp_test_"). AgentProof deliberately ` +
          `attempts unsafe transactions; never point it at live keys.`,
        "config",
        false,
      );
    }
    this.authHeader = `Basic ${Buffer.from(
      `${config.keyId}:${config.keySecret}`,
    ).toString("base64")}`;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.collectionMode = config.collectionMode ?? "order";
  }

  get mode(): CollectionMode {
    return this.collectionMode;
  }

  get keyId(): string {
    return this.config.keyId;
  }

  async createOrder(params: CreateOrderParams): Promise<ProviderOrder> {
    return this.collectionMode === "payment_link"
      ? this.createPaymentLink(params)
      : this.createPlainOrder(params);
  }

  private async createPlainOrder(
    params: CreateOrderParams,
  ): Promise<ProviderOrder> {
    const body = {
      amount: params.amountMinor, // Razorpay expects the smallest currency unit.
      currency: params.currency,
      receipt: params.receipt.slice(0, RECEIPT_MAX_LENGTH),
      notes: params.notes ?? {},
    };

    const json = await this.request<{
      id: string;
      amount: number;
      currency: string;
      status: string;
    }>("POST", "/orders", body);

    return {
      orderId: json.id,
      amountMinor: json.amount,
      currency: json.currency as Currency,
      status: (json.status as ProviderOrder["status"]) ?? "created",
    };
  }

  /**
   * Creates a hosted payment link for the Guard-approved amount.
   *
   * `reference_id` carries the same idempotency key the Orders flow puts in
   * `receipt`, and is subject to the same 40-character limit — Razorpay rejects a
   * duplicate, which is the one duplicate defence the platform provides.
   */
  private async createPaymentLink(
    params: CreateOrderParams,
  ): Promise<ProviderOrder> {
    const referenceId = params.receipt.slice(0, RECEIPT_MAX_LENGTH);

    // Reconcile before creating. Razorpay rejects a duplicate `reference_id`
    // outright ("...already exists"), so a retry would otherwise hard-fail
    // instead of resuming. Returning the existing link is the behaviour
    // INV-IDEMPOTENCY argues for: the same buyer intent yields one payable
    // artefact, and a repeated request converges on it rather than erroring or
    // — worse — quietly creating a second one under a fresh reference.
    const existing = await this.findPaymentLinkByReference(referenceId);
    if (existing) return toProviderOrder(existing);

    const json = await this.request<RazorpayPaymentLink>(
      "POST",
      "/payment_links",
      {
        amount: params.amountMinor,
        currency: params.currency,
        description: "AgentProof verified order",
        reference_id: referenceId,
        notes: params.notes ?? {},
      },
    );
    return toProviderOrder(json);
  }

  /** Looks up a payment link by the reference we control. Null when absent. */
  private async findPaymentLinkByReference(
    referenceId: string,
  ): Promise<RazorpayPaymentLink | null> {
    const json = await this.request<{
      payment_links?: RazorpayPaymentLink[];
      items?: RazorpayPaymentLink[];
    }>(
      "GET",
      `/payment_links?reference_id=${encodeURIComponent(referenceId)}`,
    );
    const items = json.payment_links ?? json.items ?? [];
    return items[0] ?? null;
  }

  async fetchPayment(paymentId: string): Promise<ProviderPayment | null> {
    try {
      const json = await this.request<RazorpayPayment>(
        "GET",
        `/payments/${paymentId}`,
      );
      return mapPayment(json);
    } catch (error) {
      if (error instanceof PaymentProviderError && /404/.test(error.message)) {
        return null;
      }
      throw error;
    }
  }

  async fetchOrderPayments(orderId: string): Promise<ProviderPayment[]> {
    if (orderId.startsWith("plink_")) return this.fetchLinkPayments(orderId);

    const json = await this.request<{ items: RazorpayPayment[] }>(
      "GET",
      `/orders/${orderId}/payments`,
    );
    return (json.items ?? []).map(mapPayment);
  }

  /**
   * Reads the payments recorded against a hosted payment link.
   *
   * The link's own `payments` array is authoritative when present. It is `null`
   * until someone pays, and can lag slightly behind the link's `status`, so a
   * link marked `paid` with the full amount settled falls back to a synthesised
   * captured payment rather than reporting nothing and stalling the caller.
   */
  private async fetchLinkPayments(
    linkId: string,
  ): Promise<ProviderPayment[]> {
    const json = await this.request<RazorpayPaymentLink>(
      "GET",
      `/payment_links/${linkId}`,
    );

    const entries = json.payments ?? [];
    if (entries.length > 0) {
      return entries.map((entry) => ({
        paymentId: entry.payment_id ?? entry.id ?? linkId,
        orderId: linkId,
        amountMinor: entry.amount ?? json.amount,
        currency: (entry.currency ?? json.currency) as Currency,
        status: mapStatus(entry.status),
      }));
    }

    if (json.status === "paid" && json.amount_paid >= json.amount) {
      return [
        {
          paymentId: `${linkId}:settled`,
          orderId: linkId,
          amountMinor: json.amount_paid,
          currency: json.currency as Currency,
          status: "captured",
        },
      ];
    }
    return [];
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      if (!response.ok) {
        throw new PaymentProviderError(
          `Razorpay ${method} ${path} failed with ${response.status}: ${text}`,
          "provider",
          response.status >= 500 || response.status === 429,
        );
      }
      return JSON.parse(text) as T;
    } catch (error) {
      if (error instanceof PaymentProviderError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new PaymentProviderError(
          `Razorpay ${method} ${path} timed out after ${this.timeoutMs}ms`,
          "timeout",
          true,
        );
      }
      throw new PaymentProviderError(
        `Razorpay ${method} ${path} network error: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "network",
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

interface RazorpayPayment {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: string;
}

function toProviderOrder(json: RazorpayPaymentLink): ProviderOrder {
  return {
    orderId: json.id,
    amountMinor: json.amount,
    currency: json.currency as Currency,
    status: json.status === "paid" ? "paid" : "created",
    hostedUrl: json.short_url,
  };
}

interface RazorpayPaymentLinkPayment {
  payment_id?: string;
  id?: string;
  amount?: number;
  currency?: string;
  status?: string;
}

interface RazorpayPaymentLink {
  id: string;
  amount: number;
  amount_paid: number;
  currency: string;
  status: string;
  short_url: string;
  reference_id: string;
  payments: RazorpayPaymentLinkPayment[] | null;
}

/** Razorpay statuses: created, authorized, captured, refunded, failed. */
function mapStatus(status: string | undefined): PaymentStatus {
  switch (status) {
    case "captured":
      return "captured";
    case "authorized":
      return "authorized";
    case "failed":
      return "failed";
    case "created":
      return "created";
    default:
      return "pending";
  }
}

function mapPayment(json: RazorpayPayment): ProviderPayment {
  return {
    paymentId: json.id,
    orderId: json.order_id,
    amountMinor: json.amount as Minor,
    currency: json.currency as Currency,
    status: mapStatus(json.status),
  };
}
