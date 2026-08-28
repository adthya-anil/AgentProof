import { afterEach, describe, expect, it } from "vitest";
import { ManualClock } from "../src/lib/core/clock.js";
import { IdFactory } from "../src/lib/core/ids.js";
import { createEnvironment, createIntent } from "../src/lib/harness.js";
import { MutationSet } from "../src/lib/hamperhub/mutations.js";
import { recheckPayment } from "../src/lib/live/session.js";
import {
  clearSessions,
  rememberSession,
} from "../src/lib/live/sessionStore.js";

/**
 * Re-checking a hosted payment after a human has paid it.
 *
 * This whole path was missing. The agent creates a payment link and correctly
 * stops, because `INV-PAYMENT-STATE` refuses to fulfil an uncaptured payment — the
 * right answer at that moment. What was wrong is that paying the link afterwards
 * changed nothing: the session environment was a local variable, discarded when the
 * run returned, so nobody ever asked the provider again and the console sat on
 * `verified=false` for ever.
 */

afterEach(() => {
  clearSessions();
});

/** Drives a journey as far as an authorised checkout with a payable order. */
async function authorisedSession(id: string) {
  const clock = new ManualClock();
  const env = createEnvironment({
    mutations: MutationSet.fixed(),
    clock,
    ids: new IdFactory(`recheck-${id}`),
  } as never);

  const intent = createIntent(env.ids, env.clock, {
    runId: `recheck_${id}`,
    utterance: "A coffee hamper under ₹1,500 — go ahead and buy it.",
    maxBudget: 1500,
  });
  env.guard.beginIntent(intent);

  const bundle = await env.guard.callTool("create_bundle", {
    items: [{ product_id: "p-coffee-arabica", quantity: 1 }],
  });
  if (!bundle.ok) throw new Error(`bundle failed: ${bundle.reason}`);
  const bundleId = (bundle.data as { bundle_id: string }).bundle_id;

  const quote = await env.guard.callTool("create_quote", { bundle_id: bundleId });
  if (!quote.ok) throw new Error(`quote failed: ${quote.reason}`);
  const { quote_id, total } = quote.data as { quote_id: string; total: number };

  const approval = await env.guard.callTool("approve_quote", {
    quote_id,
    approved_amount: total,
    confirmation_text: "Yes, go ahead and buy it.",
  });
  if (!approval.ok) throw new Error(`approval failed: ${approval.reason}`);
  const receiptId = (approval.data as { approval_receipt_id: string })
    .approval_receipt_id;

  const checkout = await env.guard.callTool("create_checkout", {
    quote_id,
    approval_receipt_id: receiptId,
  });
  if (!checkout.ok) throw new Error(`checkout failed: ${checkout.reason}`);

  const authorised = env.service
    .listCheckoutIntents(intent.id)
    .find((c) => c.status === "authorized")!;
  const attempt = env.service.findPaymentAttemptForCheckout(authorised.id)!;

  rememberSession({
    id,
    env,
    intent,
    checkoutIntentId: authorised.id,
    paymentAttemptId: attempt.id,
    hostedUrl: attempt.hostedUrl ?? "https://example.invalid/pay",
    providerOrderId: attempt.providerOrderId,
    createdAt: Date.now(),
  });

  return { env, attempt, intent };
}

describe("re-checking a hosted payment", () => {
  it("refuses to fulfil while the provider has not captured", async () => {
    await authorisedSession("unpaid");

    const result = await recheckPayment("unpaid");

    expect(result.found).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.fulfilled).toBe(false);
    // The reason names the rule doing the refusing, not a generic failure.
    expect(result.fulfilmentNote).toMatch(/INV-PAYMENT-STATE/);
  });

  it("verifies and fulfils once the provider reports the money captured", async () => {
    const { env, attempt } = await authorisedSession("paid");

    // Stand-in for a human paying the link in a browser.
    await env.fake!.simulatePayment(attempt.providerOrderId, "captured");

    const result = await recheckPayment("paid");

    expect(result.verified).toBe(true);
    expect(result.fulfilled).toBe(true);
    expect(result.status).toBe("captured");
    expect(result.amount).toBeTruthy();
  });

  it("appends real entries to the hash-chained log, leaving it intact", async () => {
    const { env, attempt } = await authorisedSession("chain");
    const before = env.audit.all().length;

    await env.fake!.simulatePayment(attempt.providerOrderId, "captured");
    const result = await recheckPayment("chain");

    // A re-check is part of the journey's record, not a side channel.
    expect(result.events.length).toBeGreaterThan(0);
    expect(env.audit.all().length).toBeGreaterThan(before);
    expect(result.auditChainOk).toBe(true);
    expect(env.audit.verify().ok).toBe(true);
  });

  it("says plainly when a session is no longer held", async () => {
    const result = await recheckPayment("never-existed");

    expect(result.found).toBe(false);
    expect(result.fulfilled).toBe(false);
    // Tells the reader why, since sessions expire and are lost on restart.
    expect(result.fulfilmentNote).toMatch(/no longer held in memory/);
  });

  it("is idempotent: re-checking does not create a second payable order", async () => {
    const { env, attempt, intent } = await authorisedSession("twice");
    await env.fake!.simulatePayment(attempt.providerOrderId, "captured");

    const first = await recheckPayment("twice");
    expect(first.fulfilled).toBe(true);

    const payableAfterFirst = env.service
      .listCheckoutIntents(intent.id)
      .filter((c) => c.status === "authorized" || c.status === "fulfilled").length;

    await recheckPayment("twice");

    const payableAfterSecond = env.service
      .listCheckoutIntents(intent.id)
      .filter((c) => c.status === "authorized" || c.status === "fulfilled").length;

    // The button is going to get pressed twice by somebody. Pressing it must not
    // mint a second order, which is the one failure here that costs real money.
    expect(payableAfterSecond).toBe(payableAfterFirst);
    expect(payableAfterSecond).toBe(1);
    expect(env.audit.verify().ok).toBe(true);
  });
});
