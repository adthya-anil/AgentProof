import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PolicyEngine } from "../src/lib/policy/engine.js";
import {
  CAPABILITIES,
  type Capability,
  CapabilitySet,
  describeCapability,
} from "../src/lib/policy/capabilities.js";
import { ALL_INVARIANTS } from "../src/lib/policy/invariants/index.js";
import type {
  EvaluationContext,
  Invariant,
} from "../src/lib/policy/invariants/types.js";
import { pass } from "../src/lib/policy/invariants/types.js";
import { buildQuote, ctx, fixture } from "./helpers.js";

/**
 * Capability declarations.
 *
 * The engine has one merchant today, built to the spec's entity model, so every
 * invariant can assume every field exists. That assumption is about to be false: a
 * real catalogue has no price version, gives stock as a boolean, and keeps allergens
 * in prose. The dangerous outcome is not an error — it is a rule that reads two absent
 * fields, finds them equal, passes, and gets counted as coverage.
 */

describe("capability sets", () => {
  it("reports nothing missing when a merchant supplies everything", () => {
    expect(CapabilitySet.full().missing(CAPABILITIES)).toEqual([]);
  });

  it("reports every requirement missing when a merchant supplies nothing", () => {
    expect(CapabilitySet.none().missing(CAPABILITIES)).toEqual(CAPABILITIES);
  });

  it("reports only the gap, not the whole requirement list", () => {
    const partial = CapabilitySet.of(["product.lookup"]);
    expect(partial.missing(["product.lookup", "product.priceVersion"])).toEqual([
      "product.priceVersion",
    ]);
  });

  it("gives every capability prose a report can print", () => {
    // A report that says `product.priceVersion` and stops has told a merchant a
    // symbol, not a thing to fix.
    for (const capability of CAPABILITIES) {
      expect(describeCapability(capability).length).toBeGreaterThan(15);
    }
  });
});

describe("the engine withholds rules it cannot run", () => {
  /** An invariant that would pass unconditionally if it were ever evaluated. */
  const wouldPass = (requires: readonly Capability[]): Invariant => ({
    id: "INV-TEST",
    title: "test rule",
    severity: "high",
    policyRefs: [],
    attribution: "integration",
    appliesAt: ["quote.created"],
    requires,
    evaluate: () => pass("evaluated"),
  });

  function contextWith(capabilities: CapabilitySet): EvaluationContext {
    const f = fixture();
    return ctx(f, {
      checkpoint: "quote.created",
      quote: buildQuote(f, [{ productId: "p-coffee-arabica", quantity: 1 }]),
      capabilities,
    });
  }

  it("does not evaluate a rule whose capability is absent", () => {
    const engine = new PolicyEngine([wouldPass(["product.priceVersion"])]);
    const result = engine.evaluate(contextWith(CapabilitySet.none()));

    // The crux. Had it evaluated, it would have passed and been counted as coverage.
    expect(result.passedCount).toBe(0);
    expect(result.unsupportedCount).toBe(1);
    expect(result.results[0]?.status).toBe("skipped");
    expect(result.results[0]?.detail).not.toBe("evaluated");
  });

  it("evaluates the same rule once the capability is present", () => {
    const engine = new PolicyEngine([wouldPass(["product.priceVersion"])]);
    const result = engine.evaluate(contextWith(CapabilitySet.full()));

    expect(result.passedCount).toBe(1);
    expect(result.unsupportedCount).toBe(0);
  });

  it("names what was missing, so the gap is actionable", () => {
    const engine = new PolicyEngine([
      wouldPass(["product.priceVersion", "inventory.version"]),
    ]);
    const result = engine.evaluate(contextWith(CapabilitySet.none()));

    expect(result.capabilityGaps).toEqual([
      {
        invariantId: "INV-TEST",
        missing: ["product.priceVersion", "inventory.version"],
      },
    ]);
    expect(result.results[0]?.detail).toContain("product.priceVersion");
    // The prose, not just the symbol.
    expect(result.results[0]?.detail).toContain("version or etag");
  });

  it("counts a withheld rule apart from one that had nothing to say", () => {
    /**
     * The distinction the whole mechanism rests on. A payment-state rule skipping at
     * quote time is coverage working; a rule skipping because the data does not exist
     * is a permanent hole. One number for both would read as the harmless case.
     */
    const engine = new PolicyEngine([wouldPass(["product.priceVersion"])]);
    const withheld = engine.evaluate(contextWith(CapabilitySet.none()));

    expect(withheld.unsupportedCount).toBe(1);
    expect(withheld.skippedCount).toBe(0);
  });

  it("does not call a withheld rule's evaluate at all", () => {
    // Not merely discarding the outcome: an invariant body that dereferences a
    // missing field would throw, and the engine turns a throw into a violation.
    let called = false;
    const engine = new PolicyEngine([
      {
        ...wouldPass(["product.priceVersion"]),
        evaluate: () => {
          called = true;
          return pass();
        },
      },
    ]);
    engine.evaluate(contextWith(CapabilitySet.none()));
    expect(called).toBe(false);
  });

  it("refuses to call a checkpoint allowed when every rule was withheld", () => {
    /**
     * `allow` would mean "nothing objected", which is true and misleading: nothing
     * ran. A caller treating allow as approval would be acting on an empty check.
     */
    const engine = new PolicyEngine([wouldPass(["product.priceVersion"])]);
    const result = engine.evaluate(contextWith(CapabilitySet.none()));

    expect(result.decision).toBe("not_applicable");
    expect(result.reason).toContain("withheld");
  });

  it("still allows when some rules ran and none objected, but says what was withheld", () => {
    const engine = new PolicyEngine([
      wouldPass([]), // needs nothing, runs
      wouldPass(["product.priceVersion"]), // withheld
    ]);
    const result = engine.evaluate(contextWith(CapabilitySet.none()));

    expect(result.decision).toBe("allow");
    expect(result.passedCount).toBe(1);
    // The audit line must not read as though all of it was checked.
    expect(result.reason).toContain("1 withheld");
  });
});

describe("declarations match what the invariants actually read", () => {
  /**
   * A drift guard, and the reason this file is worth more than its assertions.
   *
   * A declaration is a promise about source code, and source code changes. If an
   * invariant starts reading `priceVersion` without declaring the capability, every
   * mechanism above still works perfectly and silently protects nothing. Checking the
   * text is crude, but it fails loudly in exactly the case that matters.
   */
  const SOURCES: Record<string, string> = {};
  for (const file of [
    "amount",
    "confirmation",
    "currency",
    "discount",
    "expiry",
    "idempotency",
    "inventory",
    "payment",
    "price",
    "safety",
  ]) {
    SOURCES[file] = readFileSync(
      `src/lib/policy/invariants/${file}.ts`,
      "utf8",
    );
  }

  /** Field reads that imply a capability, and the capability they imply. */
  const IMPLIED: Array<{ pattern: RegExp; capability: Capability }> = [
    { pattern: /\.priceVersion/, capability: "product.priceVersion" },
    { pattern: /\.allergens/, capability: "product.allergens" },
    { pattern: /\.vegan/, capability: "product.vegan" },
    { pattern: /getReservation\(/, capability: "reservation.lookup" },
    { pattern: /freeStock\(/, capability: "inventory.available" },
    { pattern: /getProduct\(/, capability: "product.lookup" },
    { pattern: /approvedContentHash/, capability: "approval.contentHash" },
  ];

  it.each(Object.keys(SOURCES))(
    "%s.ts declares every capability its code depends on",
    (file) => {
      const source = SOURCES[file] ?? "";
      const declared = new Set<string>();
      for (const match of source.matchAll(/requires:\s*\[([^\]]*)\]/g)) {
        for (const raw of (match[1] ?? "").split(",")) {
          const trimmed = raw.trim().replace(/^["']|["']$/g, "");
          if (trimmed) declared.add(trimmed);
        }
      }

      for (const { pattern, capability } of IMPLIED) {
        if (pattern.test(source)) {
          expect(
            declared.has(capability),
            `${file}.ts reads ${pattern.source} but does not declare ${capability}`,
          ).toBe(true);
        }
      }
    },
  );

  it("declares only capabilities that exist", () => {
    // A typo in a declaration would otherwise be a requirement no merchant can ever
    // satisfy, silently disabling the rule everywhere.
    for (const invariant of ALL_INVARIANTS) {
      for (const capability of invariant.requires ?? []) {
        expect(CAPABILITIES).toContain(capability);
      }
    }
  });

  it("leaves rules that need nothing from the merchant undeclared", () => {
    /**
     * Currency, expiry, idempotency, amount, confirmation and payment-state work
     * entirely on objects the Guard itself constructs. Declaring capabilities they do
     * not need would disable them against merchants that could have run them fine.
     */
    const needsNothing = [
      "INV-CURRENCY",
      "INV-QUOTE-EXPIRY",
      "INV-IDEMPOTENCY",
      "INV-MAX-AMOUNT",
      "INV-BUDGET",
      "INV-CONFIRMATION",
      "INV-PAYMENT-STATE",
    ];
    for (const id of needsNothing) {
      const invariant = ALL_INVARIANTS.find((i) => i.id === id);
      expect(invariant, `${id} not found`).toBeDefined();
      expect(invariant?.requires ?? []).toEqual([]);
    }
  });

  it("keeps the rules that do need the catalogue declared", () => {
    const needsCatalogue = [
      "INV-PRICE-BINDING",
      "INV-INVENTORY",
      "INV-PRODUCT-SAFETY",
      "INV-DISCOUNT-CAP",
      "INV-FLOOR-PRICE",
    ];
    for (const id of needsCatalogue) {
      const invariant = ALL_INVARIANTS.find((i) => i.id === id);
      expect(invariant?.requires?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe("HamperHub really does supply everything it claims", () => {
  it("exposes a price version, an inventory version and tri-state safety data", () => {
    /**
     * The full capability set is asserted against the merchant rather than assumed.
     * If HamperHub ever stops carrying one of these, the default would start lying
     * and every rule depending on it would pass against undefined.
     */
    const f = fixture();
    const product = f.state.getProduct("p-coffee-arabica");
    expect(product?.priceVersion).toBeTypeOf("number");
    expect(Array.isArray(product?.allergens)).toBe(true);
    expect(product?.vegan).toBeDefined();

    const inventory = f.state.getInventory("p-coffee-arabica");
    expect(inventory?.version).toBeTypeOf("number");
    expect(f.state.freeStock("p-coffee-arabica")).toBeTypeOf("number");
  });
});
