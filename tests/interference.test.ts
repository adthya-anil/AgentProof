import { describe, expect, it } from "vitest";
import type { ToolCaller, ToolResult } from "../src/lib/guard/guard.js";
import type { Environment } from "../src/lib/harness.js";
import { createEnvironment } from "../src/lib/harness.js";
import { InterferingToolCaller } from "../src/lib/runner/interference.js";
import type { Interference } from "../src/lib/scenarios/types.js";

/**
 * The fault has to land before the agent's next move.
 *
 * `apply` became async when perturbing a mapped merchant became a network write, and the
 * call was left un-awaited. The write then raced the agent's very next tool call: a price
 * rise sometimes reached the merchant before checkout and sometimes did not, so the same
 * scenario alternated between catching a violation and reporting a clean pass. An
 * intermittent test that reports success when it loses the race is worse than one that
 * fails, because the failure looks like a result.
 *
 * Nothing caught it. Typecheck cannot see a missing `await` on a promise nobody reads, and
 * every existing test used a synchronous fault, where the bug is invisible. These are the
 * tests that would have.
 */

/** A caller that just succeeds, so only the interference behaviour is under test. */
const alwaysOk: ToolCaller = {
  async callTool(): Promise<ToolResult> {
    return { ok: true, data: {} };
  },
};

function env(): Environment {
  return createEnvironment({});
}

describe("an async fault completes before the tool call returns", () => {
  it("waits for a fault that resolves on a later tick", async () => {
    /**
     * The exact failure. Without an await, `callTool` returns while the fault is still
     * pending, the agent proceeds against an unchanged world, and the journey passes.
     */
    let landed = false;
    const plan: Interference = {
      afterTool: "approve_quote",
      label: "slow fault",
      apply: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        landed = true;
      },
    };

    const caller = new InterferingToolCaller(alwaysOk, plan, env());
    await caller.callTool("approve_quote", {});

    expect(landed, "callTool returned before the fault had landed").toBe(true);
    expect(caller.applied()).toBe(true);
  });

  it("does not claim a fault fired when it threw", async () => {
    // A merchant that refuses to be perturbed must leave the journey inconclusive rather
    // than claiming its fault was applied.
    const plan: Interference = {
      afterTool: "approve_quote",
      label: "impossible fault",
      apply: async () => {
        throw new Error("this merchant's prices cannot be moved");
      },
    };

    const caller = new InterferingToolCaller(alwaysOk, plan, env());
    const result = await caller.callTool("approve_quote", {});

    // The tool call itself still succeeds — the fault failing is not the agent's problem.
    expect(result.ok).toBe(true);
    expect(caller.applied()).toBe(false);
    expect(caller.failureReason()).toMatch(/cannot be moved/);
  });

  it("records what the fault changed, so a passing journey cannot hide one", async () => {
    /**
     * Without this, a journey that had a price raised under it and completed anyway read
     * exactly like one where nothing was injected — both passed, both with nothing fired.
     * Working out which had happened meant re-running and guessing.
     */
    const e = env();
    const before = e.state.getProduct("p-coffee-arabica")!.priceMinor;
    const plan: Interference = {
      afterTool: "approve_quote",
      label: "supplier raises the price",
      apply: (target) => {
        target.state.setPrice("p-coffee-arabica", before + 5000, "test");
      },
    };

    const caller = new InterferingToolCaller(alwaysOk, plan, e);
    await caller.callTool("approve_quote", {});

    expect(caller.appliedEffect()).toBeTruthy();
    expect(caller.appliedEffect()).toContain("Arabica");
    // The actual numbers, so the note is checkable rather than decorative.
    expect(caller.appliedEffect()).toContain("₹599.00");
    expect(caller.appliedEffect()).toContain("₹649.00");
  });

  it("says so plainly when a fault changed nothing", async () => {
    // A fault that ran but moved no catalogue value is not the same as one that moved
    // something, and a report that cannot tell them apart is how the un-awaited write hid.
    const plan: Interference = {
      afterTool: "approve_quote",
      label: "does nothing",
      apply: () => {},
    };

    const caller = new InterferingToolCaller(alwaysOk, plan, env());
    await caller.callTool("approve_quote", {});

    expect(caller.applied()).toBe(true);
    expect(caller.appliedEffect()).toMatch(/no catalogue value changed/);
  });
});

describe("the trigger conditions are unchanged", () => {
  it("fires only after the named tool", async () => {
    let count = 0;
    const plan: Interference = {
      afterTool: "approve_quote",
      label: "counter",
      apply: () => {
        count += 1;
      },
    };
    const caller = new InterferingToolCaller(alwaysOk, plan, env());

    await caller.callTool("create_quote", {});
    expect(count).toBe(0);
    await caller.callTool("approve_quote", {});
    expect(count).toBe(1);
  });

  it("fires once, not on every subsequent call", async () => {
    let count = 0;
    const plan: Interference = {
      afterTool: "approve_quote",
      label: "counter",
      apply: () => {
        count += 1;
      },
    };
    const caller = new InterferingToolCaller(alwaysOk, plan, env());

    await caller.callTool("approve_quote", {});
    await caller.callTool("approve_quote", {});
    expect(count).toBe(1);
  });

  it("does not fire when the trigger call failed", async () => {
    // Changing the world in response to something that did not happen.
    const failing: ToolCaller = {
      async callTool(): Promise<ToolResult> {
        return {
          ok: false,
          blockedByGuard: false,
          decision: "rejected",
          reason: "nope",
          violations: [],
          financialActionTaken: false,
        };
      },
    };
    let count = 0;
    const plan: Interference = {
      afterTool: "approve_quote",
      label: "counter",
      apply: () => {
        count += 1;
      },
    };
    const caller = new InterferingToolCaller(failing, plan, env());

    await caller.callTool("approve_quote", {});
    expect(count).toBe(0);
    expect(caller.applied()).toBe(false);
  });
});
