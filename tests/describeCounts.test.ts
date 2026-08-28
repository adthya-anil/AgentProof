import { describe, expect, it } from "vitest";
import {
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
