import { describe, expect, it } from "vitest";
import {
  describeRejectedPromos,
  describeRuleCounts,
  describeSkipped,
} from "../src/lib/policy/describeCounts.js";

/**
 * How a clean evaluation is described.
 *
 * The console rendered `Guard: 6/7 rules passed`, which invites exactly one reading:
 * one rule failed. It had not. `evaluated` counts every applicable rule and the
 * seventh was skipped, because a payment-state rule has nothing to say at quote
 * time. So a trace implied a finding on the same screen as "Every invariant that
 * applied was satisfied", and the two contradicted each other.
 */

describe("describing rule counts", () => {
  it("does not imply a failure when a rule was merely skipped", () => {
    // The reported case: 7 applicable, 6 passed, 1 skipped.
    const text = describeRuleCounts({ evaluated: 7, passed: 6, skipped: 1 });

    expect(text).toBe("6 passed, 1 not applicable");
    // The fraction is what caused the misreading, so it must be gone.
    expect(text).not.toContain("6/7");
    expect(text).not.toMatch(/fail/i);
  });

  it("says nothing about skipping when nothing was skipped", () => {
    expect(describeRuleCounts({ evaluated: 4, passed: 4, skipped: 0 })).toBe(
      "4 passed",
    );
  });

  /**
   * The counts should never fail to add up on a clean evaluation. If they do,
   * something did not pass and was not skipped, and burying it in a denominator is
   * how it would go unnoticed.
   */
  it("surfaces anything that neither passed nor was skipped", () => {
    const text = describeRuleCounts({ evaluated: 9, passed: 6, skipped: 1 });
    expect(text).toBe("6 passed, 1 not applicable, 2 unresolved");
  });

  it("reads sensibly when every rule was skipped", () => {
    expect(describeRuleCounts({ evaluated: 3, passed: 0, skipped: 3 })).toBe(
      "0 passed, 3 not applicable",
    );
  });

  it("survives a missing or malformed payload rather than rendering NaN", () => {
    // These arrive from a JSON audit payload, so the shape is not guaranteed.
    expect(describeRuleCounts({})).toBe("0 passed");
    expect(
      describeRuleCounts({ evaluated: "7", passed: null, skipped: undefined }),
    ).toBe("0 passed");
    expect(describeRuleCounts({ evaluated: -1, passed: -5 })).toBe("0 passed");
  });
});


describe("naming the rules that did not apply", () => {
  it("names them, because 'which one' is the coverage question", () => {
    expect(describeSkipped(["INV-PRODUCT-SAFETY"])).toBe(
      "not applicable here: INV-PRODUCT-SAFETY",
    );
  });

  it("lists several", () => {
    expect(describeSkipped(["INV-A", "INV-B"])).toBe(
      "not applicable here: INV-A, INV-B",
    );
  });

  it("says nothing when every rule applied", () => {
    expect(describeSkipped([])).toBeUndefined();
    expect(describeSkipped(undefined)).toBeUndefined();
  });

  it("ignores a malformed payload rather than rendering junk", () => {
    // Arrives from a JSON audit payload, so the shape is not guaranteed.
    expect(describeSkipped("INV-A")).toBeUndefined();
    expect(describeSkipped([1, null])).toBeUndefined();
  });
});


describe("describing refused promotions", () => {
  /**
   * A quote showing "discounts ₹0" after the agent asked for FESTIVE10 is
   * indistinguishable from a promo code being silently swallowed. The agent was
   * always told in the tool response; the audit trail was not, so a reader of the
   * trace could not tell a correctly enforced 5% cap from a merchant quietly
   * dropping requests. Only one of those is a defect.
   */
  it("names the code and the reason it was refused", () => {
    expect(
      describeRejectedPromos([
        { code: "FESTIVE10", reason: "Component rate 10% exceeds cap" },
      ]),
    ).toBe(" — refused: FESTIVE10 (Component rate 10% exceeds cap)");
  });

  it("lists several refusals", () => {
    expect(
      describeRejectedPromos([
        { code: "A", reason: "one" },
        { code: "B", reason: "two" },
      ]),
    ).toBe(" — refused: A (one); B (two)");
  });

  it("still names a code that arrived without a reason", () => {
    // Better to report the refusal without a reason than to hide it.
    expect(describeRejectedPromos([{ code: "FESTIVE10" }])).toBe(
      " — refused: FESTIVE10 (refused)",
    );
  });

  it("says nothing when every promotion applied", () => {
    expect(describeRejectedPromos([])).toBeUndefined();
    expect(describeRejectedPromos(undefined)).toBeUndefined();
  });

  it("ignores a malformed payload rather than rendering junk", () => {
    expect(describeRejectedPromos("FESTIVE10")).toBeUndefined();
    expect(describeRejectedPromos([null, 42])).toBeUndefined();
  });
});

describe("the audit trail records a refused promotion", () => {
  /**
   * The gap this closes: the tool response carried `rejected_promo_codes` and the
   * `quote.created` audit event did not, so the tamper-evident log — the record the
   * whole product rests on — omitted a declined 10% discount.
   */
  it("puts refused promotions in the quote.created event", async () => {
    const { createEnvironment, createIntent } = await import(
      "../src/lib/harness.js"
    );
    const { MutationSet } = await import("../src/lib/hamperhub/mutations.js");

    const env = createEnvironment({ mutations: MutationSet.fixed() });
    const intent = createIntent(env.ids, env.clock, {
      runId: "promo-audit",
      utterance: "coffee hamper",
      maxBudget: 1500,
    });
    env.guard.beginIntent(intent);

    const bundle = await env.guard.callTool("create_bundle", {
      items: [{ product_id: "p-coffee-arabica", quantity: 1 }],
      // 10% against a 5% cap: must be refused, and the refusal must be recorded.
      promo_codes: ["FESTIVE10"],
    });
    if (!bundle.ok) throw new Error(`bundle failed: ${bundle.reason}`);

    await env.guard.callTool("create_quote", {
      bundle_id: (bundle.data as { bundle_id: string }).bundle_id,
    });

    const event = env.audit.all().find((e) => e.type === "quote.created");
    const refused = (event?.output as { rejected_promo_codes?: unknown })
      ?.rejected_promo_codes;

    expect(Array.isArray(refused)).toBe(true);
    expect(refused).toHaveLength(1);
    expect((refused as Array<{ code: string }>)[0]!.code).toBe("FESTIVE10");
    // And it reads as a cap decision, not a mystery.
    expect(describeRejectedPromos(refused)).toMatch(/FESTIVE10/);
  });
});
