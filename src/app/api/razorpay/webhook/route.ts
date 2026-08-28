import { loadDotEnv } from "@/lib/core/env";
import { recheckPaymentForProviderId } from "@/lib/live/session";
import {
  ACTIONABLE_WEBHOOK_EVENTS,
  readWebhookSubject,
  verifyWebhookSignature,
} from "@/lib/payments/webhook";

/**
 * Razorpay webhook: settles a journey the moment the buyer actually pays.
 *
 * This is the production-correct half of payment sync. Polling works on a laptop
 * because localhost is not reachable from Razorpay; a real deployment gets told.
 *
 * Two rules shape this handler:
 *
 *  1. **Nothing is believed until the signature verifies.** An unauthenticated
 *     webhook that marks orders paid is a way for anyone to have goods dispatched
 *     for free. A tool that argues money should move only when deterministic checks
 *     agree cannot take a POST body at its word.
 *
 *  2. **The payload is a trigger, not a source of truth.** Even after verifying, we
 *     do not read an amount or a status out of the body and apply it. We go and ask
 *     Razorpay what happened, then put that answer through the same Guard
 *     checkpoints as everything else.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  loadDotEnv();

  // Raw body, unparsed: the signature covers exact bytes, and re-serialising JSON
  // changes them.
  const rawBody = await request.text();
  const signature = request.headers.get("x-razorpay-signature");

  const verification = verifyWebhookSignature(
    rawBody,
    signature,
    process.env.RAZORPAY_WEBHOOK_SECRET,
  );
  if (!verification.ok) {
    // 401, not 400: this is an authentication failure, and Razorpay should not
    // retry a payload we will never accept.
    return Response.json(
      { accepted: false, reason: verification.reason },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return Response.json(
      { accepted: false, reason: "Body was not valid JSON." },
      { status: 400 },
    );
  }

  const subject = readWebhookSubject(body);

  // Acknowledge anything we do not act on. A non-2xx makes Razorpay retry, and
  // retrying an event we simply do not care about is pointless traffic.
  if (!ACTIONABLE_WEBHOOK_EVENTS.includes(subject.event)) {
    return Response.json({ accepted: true, ignored: subject.event });
  }

  const providerId = subject.paymentLinkId ?? subject.orderId;
  if (!providerId) {
    return Response.json({ accepted: true, ignored: "no provider id in payload" });
  }

  const result = await recheckPaymentForProviderId(providerId);

  // 200 even when no session matched. The event is genuine and correctly
  // authenticated; we simply no longer hold that journey in memory, and asking
  // Razorpay to redeliver will not change that.
  return Response.json({
    accepted: true,
    event: subject.event,
    providerId,
    matched: result.found,
    verified: result.verified,
    fulfilled: result.fulfilled,
  });
}
