import type { BuyerIntent } from "../core/types.js";
import type { Environment } from "../harness.js";

/**
 * Keeps a finished live session reachable so its payment can be re-checked.
 *
 * A hosted payment link is inherently asynchronous: the agent creates it, the Guard
 * authorises it, and then a human goes off and pays it — long after the journey has
 * concluded. The session environment used to be a local in `runLiveSession`, so the
 * moment the run ended there was nothing left to verify against. You could pay the
 * link successfully and the console would sit there forever showing
 * `verified=false`, because nothing was ever going to look again.
 *
 * Holding the environment lets a re-check do the honest thing: ask Razorpay what
 * actually happened, put the answer back through the same Guard checkpoints, and
 * then attempt the fulfilment that `INV-PAYMENT-STATE` was blocking.
 */

export interface LiveSessionHandle {
  id: string;
  env: Environment;
  intent: BuyerIntent;
  checkoutIntentId: string;
  paymentAttemptId: string;
  hostedUrl: string;
  /** The provider's id — `plink_…` or `order_…` — for matching a webhook. */
  providerOrderId: string;
  createdAt: number;
}

/**
 * Bounded and time-limited. These hold a whole merchant environment each, and a
 * dashboard left open for a day should not accumulate them.
 */
const MAX_SESSIONS = 20;
const TTL_MS = 60 * 60 * 1000;

const sessions = new Map<string, LiveSessionHandle>();

export function rememberSession(handle: LiveSessionHandle): void {
  evictStale();
  sessions.set(handle.id, handle);

  // Oldest first, because Map preserves insertion order.
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

export function getSession(id: string): LiveSessionHandle | null {
  evictStale();
  return sessions.get(id) ?? null;
}

/**
 * Finds a session by the provider's own identifier.
 *
 * A webhook knows nothing about our session ids — it reports a payment link or an
 * order. Matching on the provider id is what lets Razorpay's own notification
 * settle the journey it belongs to.
 */
export function findSessionByProviderId(
  providerId: string,
): LiveSessionHandle | null {
  evictStale();
  for (const handle of sessions.values()) {
    if (handle.providerOrderId === providerId) return handle;
  }
  return null;
}

export function clearSessions(): void {
  sessions.clear();
}

function evictStale(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, handle] of sessions) {
    if (handle.createdAt < cutoff) sessions.delete(id);
  }
}
