import { describe, expect, it } from "vitest";
import {
  type ScopedRecheck,
  shouldWatchPayment,
  visibleRecheck,
} from "../src/lib/live/scopedRecheck.js";
import type { RecheckResult } from "../src/lib/live/session.js";

/**
 * A re-check must never be shown against a session it did not come from.
 *
 * The console reset rows, summary and payment link when a new run started, and left
 * the previous run's re-check untouched. So a fresh journey whose order was ₹1,247
 * displayed "Payment captured and order fulfilled — ₹1,277.00" from the run before
 * it: a confident claim that money had arrived, for a payment nobody had made.
 *
 * These tests cover the pure rule rather than the component, because the rule is
 * where the guarantee lives. Pairing a result with its session makes staleness
 * unrepresentable instead of relying on somebody remembering to clear it.
 */

function result(overrides: Partial<RecheckResult> = {}): RecheckResult {
  return {
    found: true,
    status: "captured",
    verified: true,
    fulfilled: true,
    fulfilmentNote: null,
    events: [],
    auditChainOk: true,
    amount: "₹1,277.00",
    ...overrides,
  };
}

const stored: ScopedRecheck = { sessionId: "session-a", result: result() };

describe("which result is visible", () => {
  it("shows a result for the session that produced it", () => {
    expect(visibleRecheck(stored, "session-a")).toBe(stored.result);
  });

  /** The reported bug, reduced to one assertion. */
  it("hides a result from a previous session", () => {
    expect(visibleRecheck(stored, "session-b")).toBeNull();
  });

  it("hides everything once there is no payment panel", () => {
    expect(visibleRecheck(stored, null)).toBeNull();
    expect(visibleRecheck(stored, undefined)).toBeNull();
  });

  it("has nothing to show before any re-check", () => {
    expect(visibleRecheck(null, "session-a")).toBeNull();
  });
});

describe("whether to keep watching for payment", () => {
  it("watches a new session with no result yet", () => {
    expect(shouldWatchPayment(null, "session-a")).toBe(true);
  });

  /**
   * The quieter half of the same bug. The watch loop skipped any run whose
   * `recheckResult` was already truthy, so automatic payment sync worked exactly
   * once per page load and then silently stopped.
   */
  it("watches a new session even after a previous one succeeded", () => {
    expect(shouldWatchPayment(stored, "session-b")).toBe(true);
  });

  it("stops once this session's payment is confirmed", () => {
    expect(shouldWatchPayment(stored, "session-a")).toBe(false);
  });

  it("keeps watching while this session is still unpaid", () => {
    const unpaid: ScopedRecheck = {
      sessionId: "session-a",
      result: result({ verified: false, fulfilled: false, status: "created" }),
    };
    expect(shouldWatchPayment(unpaid, "session-a")).toBe(true);
  });

  it("stops when the payment is captured but fulfilment was refused", () => {
    // Money has arrived, so there is nothing further to wait for; whatever
    // blocked fulfilment is a policy outcome, not a pending payment.
    const captured: ScopedRecheck = {
      sessionId: "session-a",
      result: result({ verified: true, fulfilled: false }),
    };
    expect(shouldWatchPayment(captured, "session-a")).toBe(false);
  });

  it("does not watch when there is no session", () => {
    expect(shouldWatchPayment(null, null)).toBe(false);
  });
});
