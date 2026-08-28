import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Razorpay webhook verification.
 *
 * An unauthenticated webhook that marks orders paid is a way for anyone on the
 * internet to have goods dispatched for free. Given this project exists to argue
 * that money should move only when deterministic checks agree, taking a POST body
 * at its word would be indefensible — so a payload is worthless here until its
 * signature is verified against the shared secret.
 *
 * Razorpay signs the raw request body with HMAC-SHA256 and sends the digest in
 * `X-Razorpay-Signature`. The body must be verified exactly as received: parsing
 * and re-serialising changes bytes and the digest will not match.
 */

export interface WebhookVerification {
  ok: boolean;
  reason?: string;
}

export function verifyWebhookSignature(
  rawBody: string,
  signature: string | null,
  secret: string | undefined,
): WebhookVerification {
  if (!secret) {
    return {
      ok: false,
      reason:
        "RAZORPAY_WEBHOOK_SECRET is not set, so this payload cannot be " +
        "authenticated. Refusing it rather than trusting it.",
    };
  }
  if (!signature) {
    return { ok: false, reason: "Missing X-Razorpay-Signature header." };
  }

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");

  // Length must match before timingSafeEqual, which throws on a mismatch.
  if (expected.length !== signature.length) {
    return { ok: false, reason: "Signature length mismatch." };
  }
  // Constant-time, so a wrong signature cannot be discovered byte by byte.
  const matches = timingSafeEqual(
    Buffer.from(expected, "utf8"),
    Buffer.from(signature, "utf8"),
  );

  return matches ? { ok: true } : { ok: false, reason: "Signature mismatch." };
}

/** The provider ids a payment event refers to, in priority order. */
export interface WebhookSubject {
  event: string;
  /** `plink_…` when the event concerns a payment link. */
  paymentLinkId: string | null;
  /** `order_…` when the event concerns an order. */
  orderId: string | null;
  paymentId: string | null;
}

/**
 * Pulls the identifiers out of a webhook body.
 *
 * Deliberately tolerant of shape: Razorpay nests entities differently per event,
 * and a webhook that throws on an event we did not anticipate would fail the whole
 * delivery rather than acknowledge and ignore it.
 */
export function readWebhookSubject(body: unknown): WebhookSubject {
  const root = (body ?? {}) as Record<string, unknown>;
  const payload = (root.payload ?? {}) as Record<string, unknown>;

  const entityOf = (key: string): Record<string, unknown> => {
    const wrapper = payload[key] as Record<string, unknown> | undefined;
    return (wrapper?.entity ?? {}) as Record<string, unknown>;
  };

  const link = entityOf("payment_link");
  const payment = entityOf("payment");
  const order = entityOf("order");

  const str = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 ? value : null;

  return {
    event: str(root.event) ?? "unknown",
    paymentLinkId: str(link.id),
    orderId: str(order.id) ?? str(payment.order_id),
    paymentId: str(payment.id),
  };
}

/**
 * Events worth acting on.
 *
 * Anything else is acknowledged and ignored: Razorpay retries on a non-2xx, so
 * returning an error for an event we simply do not care about would generate
 * pointless retry traffic.
 */
export const ACTIONABLE_WEBHOOK_EVENTS: readonly string[] = Object.freeze([
  "payment_link.paid",
  "payment.captured",
  "order.paid",
]);
