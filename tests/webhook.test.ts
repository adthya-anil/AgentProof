import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ACTIONABLE_WEBHOOK_EVENTS,
  readWebhookSubject,
  verifyWebhookSignature,
} from "../src/lib/payments/webhook.js";

/**
 * Webhook authentication.
 *
 * An unauthenticated webhook that marks orders paid is a way for anyone on the
 * internet to have goods dispatched for free. A project arguing that money should
 * move only when deterministic checks agree cannot take a POST body at its word, so
 * every one of these is a rule about refusing to believe things.
 */

const SECRET = "whsec_test_abc123";

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("signature verification", () => {
  const body = JSON.stringify({ event: "payment_link.paid" });

  it("accepts a correctly signed body", () => {
    expect(verifyWebhookSignature(body, sign(body), SECRET).ok).toBe(true);
  });

  it("refuses a body signed with the wrong secret", () => {
    const forged = sign(body, "whsec_attacker");
    const result = verifyWebhookSignature(body, forged, SECRET);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/mismatch/i);
  });

  it("refuses a tampered body even when the signature is otherwise valid", () => {
    // Signature covers exact bytes, so a changed amount must invalidate it.
    const signature = sign(body);
    const tampered = JSON.stringify({ event: "payment_link.paid", extra: 1 });
    expect(verifyWebhookSignature(tampered, signature, SECRET).ok).toBe(false);
  });

  it("refuses when no signature header was sent", () => {
    const result = verifyWebhookSignature(body, null, SECRET);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing/i);
  });

  /**
   * The important one. An unset secret must fail closed: a deployment that forgot
   * to configure it should reject payloads, never accept them unverified.
   */
  it("refuses everything when no secret is configured", () => {
    const result = verifyWebhookSignature(body, sign(body), undefined);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/RAZORPAY_WEBHOOK_SECRET/);
  });

  it("does not throw on a signature of the wrong length", () => {
    // timingSafeEqual throws on differing lengths; the guard must come first.
    expect(() => verifyWebhookSignature(body, "abc", SECRET)).not.toThrow();
    expect(verifyWebhookSignature(body, "abc", SECRET).ok).toBe(false);
  });
});

describe("reading the subject of an event", () => {
  it("finds a payment link id", () => {
    const subject = readWebhookSubject({
      event: "payment_link.paid",
      payload: {
        payment_link: { entity: { id: "plink_TVGHYCbwGBE6HH" } },
        payment: { entity: { id: "pay_abc", order_id: "order_xyz" } },
      },
    });

    expect(subject.event).toBe("payment_link.paid");
    expect(subject.paymentLinkId).toBe("plink_TVGHYCbwGBE6HH");
    expect(subject.paymentId).toBe("pay_abc");
  });

  it("falls back to the order id on a payment event", () => {
    const subject = readWebhookSubject({
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_1", order_id: "order_1" } } },
    });

    expect(subject.paymentLinkId).toBeNull();
    expect(subject.orderId).toBe("order_1");
  });

  /**
   * Tolerance is deliberate. Razorpay nests entities differently per event, and
   * throwing on an unfamiliar shape would fail the whole delivery instead of
   * acknowledging and ignoring it.
   */
  it("survives an unrecognised or empty payload", () => {
    expect(() => readWebhookSubject({})).not.toThrow();
    expect(() => readWebhookSubject(null)).not.toThrow();
    expect(readWebhookSubject({}).event).toBe("unknown");
    expect(readWebhookSubject({ payload: { payment: {} } }).paymentId).toBeNull();
  });

  it("acts only on events that mean money arrived", () => {
    expect(ACTIONABLE_WEBHOOK_EVENTS).toContain("payment_link.paid");
    expect(ACTIONABLE_WEBHOOK_EVENTS).toContain("payment.captured");
    // A created link is not a paid one.
    expect(ACTIONABLE_WEBHOOK_EVENTS).not.toContain("payment_link.created");
    expect(ACTIONABLE_WEBHOOK_EVENTS).not.toContain("payment.failed");
  });
});
