import type { Clock } from "../core/clock.js";
import type { IdFactory } from "../core/ids.js";
import type { PaymentStatus } from "../core/types.js";
import {
  type CreateOrderParams,
  type PaymentProvider,
  PaymentProviderError,
  type ProviderOrder,
  type ProviderPayment,
} from "./provider.js";

export interface FaultPlan {
  /** Fail the Nth createOrder call (1-indexed) with a retryable timeout. */
  timeoutOnCreateOrderAttempt?: number;
  /** Force the outcome of the next simulated payment. */
  paymentOutcome?: PaymentStatus;
}

/**
 * Deterministic in-process payment provider.
 *
 * Used for preflight runs, where thousands of orders against a real sandbox
 * would be slow, rate-limited and impossible to complete without a browser.
 * It reproduces the two provider behaviours the invariants care about: a
 * create-order call that times out *after* the order was actually created
 * (the classic duplicate-charge trap), and payments that fail rather than
 * capture.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = "fake";
  readonly isReal = false;

  private orders = new Map<string, ProviderOrder>();
  private payments = new Map<string, ProviderPayment>();
  private byOrder = new Map<string, string[]>();
  private createOrderCalls = 0;

  constructor(
    private readonly ids: IdFactory,
    private readonly clock: Clock,
    private faults: FaultPlan = {},
  ) {}

  setFaults(faults: FaultPlan): void {
    this.faults = faults;
  }

  resetCallCounts(): void {
    this.createOrderCalls = 0;
  }

  async createOrder(params: CreateOrderParams): Promise<ProviderOrder> {
    this.createOrderCalls += 1;
    const order: ProviderOrder = {
      orderId: this.ids.next("order"),
      amountMinor: params.amountMinor,
      currency: params.currency,
      status: "created",
    };
    // The order is stored *before* the fault fires: from the caller's point of
    // view the request timed out, but the provider really did create it. This is
    // exactly why a retry without an idempotency key double-charges.
    this.orders.set(order.orderId, order);

    if (this.faults.timeoutOnCreateOrderAttempt === this.createOrderCalls) {
      throw new PaymentProviderError(
        "Timed out waiting for order confirmation",
        "timeout",
        true,
      );
    }
    return order;
  }

  async fetchPayment(paymentId: string): Promise<ProviderPayment | null> {
    return this.payments.get(paymentId) ?? null;
  }

  async fetchOrderPayments(orderId: string): Promise<ProviderPayment[]> {
    const ids = this.byOrder.get(orderId) ?? [];
    return ids
      .map((id) => this.payments.get(id))
      .filter((p): p is ProviderPayment => Boolean(p));
  }

  /** Test-only: completes a payment for an order. */
  async simulatePayment(
    orderId: string,
    outcome: PaymentStatus = "captured",
  ): Promise<ProviderPayment> {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new PaymentProviderError(`Unknown order ${orderId}`, "provider", false);
    }
    const status = this.faults.paymentOutcome ?? outcome;
    const payment: ProviderPayment = {
      paymentId: this.ids.next("pay"),
      orderId,
      amountMinor: order.amountMinor,
      currency: order.currency,
      status,
    };
    this.payments.set(payment.paymentId, payment);
    this.byOrder.set(orderId, [
      ...(this.byOrder.get(orderId) ?? []),
      payment.paymentId,
    ]);
    order.status = status === "captured" ? "paid" : "attempted";
    void this.clock;
    return payment;
  }

  /** Every order created, including those hidden behind a simulated timeout. */
  allOrders(): ProviderOrder[] {
    return [...this.orders.values()];
  }
}
