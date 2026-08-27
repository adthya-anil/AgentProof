import type { Currency, Minor } from "../core/money.js";
import type { PaymentStatus } from "../core/types.js";

export interface CreateOrderParams {
  amountMinor: Minor;
  currency: Currency;
  receipt: string;
  idempotencyKey: string;
  notes?: Record<string, string>;
}

export interface ProviderOrder {
  orderId: string;
  amountMinor: Minor;
  currency: Currency;
  status: "created" | "attempted" | "paid";
  /**
   * Hosted page where a human can complete this payment, when the provider
   * offers one.
   *
   * Razorpay Checkout needs its browser SDK, which a CLI cannot drive. A hosted
   * payment link is the only way to complete a real test payment without a
   * bundled front end, so the provider surfaces the URL when it has one.
   */
  hostedUrl?: string;
}

export interface ProviderPayment {
  paymentId: string;
  orderId: string;
  amountMinor: Minor;
  currency: Currency;
  status: PaymentStatus;
}

/**
 * The payment boundary.
 *
 * Only the Guard-authorised path holds an instance of this. The buyer agent
 * never receives a provider client or credentials — it can request a checkout,
 * but the ability to actually create a payable order sits behind the policy
 * engine by construction, not by convention.
 */
export interface PaymentProvider {
  readonly name: string;
  /** True when calls hit a real provider sandbox rather than an in-process fake. */
  readonly isReal: boolean;
  createOrder(params: CreateOrderParams): Promise<ProviderOrder>;
  fetchPayment(paymentId: string): Promise<ProviderPayment | null>;
  fetchOrderPayments(orderId: string): Promise<ProviderPayment[]>;
}

export class PaymentProviderError extends Error {
  constructor(
    message: string,
    readonly kind: "timeout" | "network" | "provider" | "config",
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "PaymentProviderError";
  }
}
