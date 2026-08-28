import type { RecheckResult } from "./session.js";

/**
 * A re-check result bound to the session that produced it.
 *
 * Exists because binding it was not optional and clearing it was. The console reset
 * rows, summary and payment link when a new run started but left the previous
 * run's re-check in place, so a fresh journey with a ₹1,247 order displayed
 * "Payment captured and order fulfilled — ₹1,277.00" from the run before it. In a
 * product whose claim is that its reports mean what they say, announcing that money
 * arrived when it has not is the worst reading of the worst bug.
 *
 * Adding a `setRecheckResult(null)` to the reset would have fixed that instance and
 * left the next one available: the guard would live in whichever function someone
 * remembered to update. Pairing the result with its session id instead makes
 * staleness unrepresentable — a result can only render for the session it came from,
 * whether or not anyone remembered to clear it.
 */
export interface ScopedRecheck {
  sessionId: string;
  result: RecheckResult;
}

/**
 * The result to display for the current session, or null.
 *
 * Also returns null when there is no current session, so a re-check cannot outlive
 * the payment panel it belongs to.
 */
export function visibleRecheck(
  stored: ScopedRecheck | null,
  currentSessionId: string | null | undefined,
): RecheckResult | null {
  if (!stored || !currentSessionId) return null;
  return stored.sessionId === currentSessionId ? stored.result : null;
}

/**
 * Whether to keep asking the provider about this payment.
 *
 * Scoped for the same reason: a previous session's success must not stop the poller
 * from watching the current one. That was the quieter half of the same bug — the
 * watch loop skipped every run after the first, so automatic payment sync silently
 * worked exactly once per page load.
 */
export function shouldWatchPayment(
  stored: ScopedRecheck | null,
  currentSessionId: string | null | undefined,
): boolean {
  if (!currentSessionId) return false;
  const visible = visibleRecheck(stored, currentSessionId);
  if (!visible) return true;
  // Settled: the money is confirmed, so there is nothing left to wait for.
  return !visible.verified && !visible.fulfilled;
}
