import { describe, expect, it } from "vitest";
import { rupees } from "../src/lib/core/money.js";
import {
  describeAllergens,
  describeVegan,
  getStorefront,
} from "../src/lib/dashboard/merchant.js";
import {
  SHOWCASE_OPTIONS,
  runShowcase,
  showcaseOptionByKey,
} from "../src/lib/dashboard/showcase.js";
import { PERTURBATION_SCENARIOS } from "../src/lib/scenarios/perturbations.js";
import { REGRESSION_SCENARIOS } from "../src/lib/scenarios/regression.js";

describe("storefront", () => {
  const store = getStorefront();

  it("exposes the whole catalog with stock", () => {
    expect(store.products).toHaveLength(17);
    expect(store.totalUnitsInStock).toBeGreaterThan(0);
    expect(store.merchant.id).toBe("hamperhub");
  });

  it("shows the six tools an AI buyer is given", () => {
    expect(store.tools.map((t) => t.name).sort()).toEqual([
      "approve_quote",
      "create_bundle",
      "create_checkout",
      "create_quote",
      "get_payment_status",
      "search_products",
    ]);
    // A signature is useless without parameter names.
    const search = store.tools.find((t) => t.name === "search_products")!;
    expect(search.parameters).toContain("exclude_allergens");
  });

  it("lists the promotions, including the pair that stacks", () => {
    const codes = store.promos.map((p) => p.code);
    expect(codes).toContain("HAMPER4");
    expect(codes).toContain("LOYAL49");
    expect(store.promos.find((p) => p.code === "HAMPERCREDIT")?.value).toBe(
      "₹47 off",
    );
  });

  it("distinguishes unpublished safety data from verified-none", () => {
    const truffle = store.products.find((p) => p.id === "p-choc-truffle")!;
    const coffee = store.products.find((p) => p.id === "p-coffee-arabica")!;

    // This distinction is the entire basis of INV-PRODUCT-SAFETY.
    expect(truffle.allergenState).toBe("unknown");
    expect(truffle.hasUnknownSafetyData).toBe(true);
    expect(describeAllergens(truffle)).toBe("not published");

    expect(coffee.allergenState).toBe("known");
    expect(coffee.hasUnknownSafetyData).toBe(false);
    expect(describeAllergens(coffee)).toBe("none declared");
    expect(describeVegan(coffee)).toBe("vegan");
  });

  it("counts exactly the products with incomplete data", () => {
    expect(store.unknownSafetyCount).toBe(
      store.products.filter((p) => p.hasUnknownSafetyData).length,
    );
    expect(store.unknownSafetyCount).toBe(1);
  });

  it("publishes a floor price below list for every product", () => {
    for (const product of store.products) {
      expect(product.minPriceMinor).toBeLessThan(product.priceMinor);
      expect(product.minPriceMinor).toBeGreaterThan(0);
    }
  });

  it("describes the seed catalog, not a mutated run", () => {
    // Two calls must agree; a live snapshot would drift between renders.
    expect(getStorefront().products.map((p) => p.priceMinor)).toEqual(
      store.products.map((p) => p.priceMinor),
    );
    expect(
      store.products.find((p) => p.id === "p-coffee-arabica")?.priceMinor,
    ).toBe(rupees(599));
  });
});

describe("agent showcase", () => {
  it("points every curated option at a real scenario", () => {
    const known = new Set(
      [...REGRESSION_SCENARIOS, ...PERTURBATION_SCENARIOS].map((s) => s.id),
    );
    for (const option of SHOWCASE_OPTIONS) {
      expect(known, `${option.key} -> ${option.scenarioId}`).toContain(
        option.scenarioId,
      );
    }
  });

  it("falls back to the happy path for an unknown key", () => {
    expect(showcaseOptionByKey("nonsense").key).toBe("happy");
  });

  it("completes the happy path on both integrations", async () => {
    for (const variant of ["vulnerable", "fixed"] as const) {
      const result = await runShowcase("happy", variant);
      expect(result?.disposition).toBe("passed");
      expect(result?.providerOrders).toBe(1);
      expect(result?.defects).toEqual([]);
      // The demo's headline number.
      expect(result?.quote?.total).toBe(1399);
    }
  });

  it("shows the identical request failing only on the vulnerable integration", async () => {
    const vulnerable = await runShowcase("discounts", "vulnerable");
    const fixed = await runShowcase("discounts", "fixed");

    expect(vulnerable?.utterance).toBe(fixed?.utterance);
    expect(vulnerable?.disposition).toBe("unsafe_violation");
    expect(vulnerable?.defects.map((d) => d.invariantId)).toContain(
      "INV-DISCOUNT-CAP",
    );
    expect(fixed?.defects).toEqual([]);
  });

  it("extracts the agent's tool calls and the quote it produced", async () => {
    const result = await runShowcase("happy", "fixed");
    expect(result?.toolCalls.length).toBeGreaterThan(3);
    expect(result?.toolCalls.map((c) => c.tool)).toContain("create_quote");
    expect(result?.quote?.lines.length).toBeGreaterThan(0);
    expect(result?.quote?.subtotal).toBe(1446);
    expect(result?.quote?.discounts[0]?.code).toBe("HAMPERCREDIT");
  });

  it("reports a Guard verdict for each checkpoint reached", async () => {
    const result = await runShowcase("happy", "fixed");
    expect(result?.checkpoints.length).toBeGreaterThan(0);
    for (const checkpoint of result!.checkpoints) {
      expect(checkpoint.checkpoint.length).toBeGreaterThan(0);
      expect(["allow", "block", "escalate", "not_applicable"]).toContain(
        checkpoint.decision,
      );
    }
  });

  it("creates no payable order when stock vanishes after approval", async () => {
    const result = await runShowcase("stockout", "fixed");
    expect(result?.providerOrders).toBe(0);
  });

  it("escalates rather than guesses on unpublished allergen data", async () => {
    const result = await runShowcase("allergy", "vulnerable");
    const fired = [
      ...(result?.violations ?? []),
      ...(result?.escalations ?? []),
    ].map((v) => v.invariantId);
    expect(fired).toContain("INV-PRODUCT-SAFETY");
  });

  it("surfaces what the environment did for perturbation scenarios", async () => {
    const result = await runShowcase("delay", "fixed");
    expect(result?.perturbations.length).toBeGreaterThan(0);
    expect(result?.perturbations.join(" ")).toMatch(/clock|paused/i);
  });

  it("always carries a deterministic explanation and an intact chain", async () => {
    for (const option of SHOWCASE_OPTIONS) {
      const result = await runShowcase(option.key, "vulnerable");
      expect(result).not.toBeNull();
      expect(result!.explanation.length).toBeGreaterThan(0);
      expect(result!.auditChainOk).toBe(true);
      expect(result!.auditTrail.length).toBeGreaterThan(0);
    }
  });
});
