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

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  timeoutMs?: number;
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
  }

  get keyId(): string {
    return this.config.keyId;
  }

  async createOrder(params: CreateOrderParams): Promise<ProviderOrder> {
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
    const json = await this.request<{ items: RazorpayPayment[] }>(
      "GET",
      `/orders/${orderId}/payments`,
    );
    return (json.items ?? []).map(mapPayment);
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

/** Razorpay statuses: created, authorized, captured, refunded, failed. */
function mapPayment(json: RazorpayPayment): ProviderPayment {
  const status: PaymentStatus =
    json.status === "captured"
      ? "captured"
      : json.status === "authorized"
        ? "authorized"
        : json.status === "failed"
          ? "failed"
          : json.status === "created"
            ? "created"
            : "pending";
  return {
    paymentId: json.id,
    orderId: json.order_id,
    amountMinor: json.amount as Minor,
    currency: json.currency as Currency,
    status,
  };
}
