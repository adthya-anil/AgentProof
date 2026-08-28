import { describe, expect, it } from "vitest";
import type { ToolResult } from "../src/lib/guard/guard.js";
import { createEnvironment, createIntent } from "../src/lib/harness.js";
import { SEED_CATALOG, SEED_INVENTORY } from "../src/lib/hamperhub/catalog.js";
import { MerchantAdapter } from "../src/lib/merchant/adapter.js";
import { parseMerchantSchema } from "../src/lib/merchant/mapping.js";
import { AdapterCatalogSource } from "../src/lib/merchant/source.js";
import { transportFor, type Fetcher } from "../src/lib/merchant/transport.js";

/**
 * The twelve invariants, running against a merchant they were not written for.
 *
 * The unit tests prove the mapping reads fields and the adapter derives capabilities.
 * This file proves the thing that actually matters: a complete journey evaluated by the
 * real Guard, with catalogue state arriving over HTTP in a shape nobody here chose, and
 * the rules still reaching the right verdicts.
 *
 * The fake merchant deliberately looks nothing like the entity model. Prices are decimal
 * strings under `pricing.retail`, ids are `sku`, stock is `warehouse.on_hand`, allergens
 * are a comma-delimited string, and there is no price version or inventory version
 * anywhere.
 */

/**
 * Unwraps a successful tool result, failing with the Guard's own reason if it was not.
 *
 * `ToolResult` is a discriminated union — `data` exists only on success and `reason`
 * only on failure — so a test that reaches for both needs to narrow first. Doing it here
 * keeps every assertion below readable and makes a failure message say what the Guard
 * actually objected to rather than "cannot read property of undefined".
 */
function ok<T = Record<string, unknown>>(result: ToolResult): T {
  if (!result.ok) {
    throw new Error(`expected success, got: ${result.reason}`);
  }
  return result.data as T;
}

/** Serves HamperHub's catalogue in a foreign shape, over a fake REST endpoint. */
function foreignMerchant(
  overrides: Record<string, { retail?: string; onHand?: number }> = {},
) {
  let requests = 0;

  /**
   * Built per request, not once up front.
   *
   * Deliberate: a test that re-prices mid-journey has to change what the merchant
   * *answers*, and an eagerly-built row would freeze the price at setup time. The first
   * version of this file did exactly that, and the price-move test passed the checkout
   * because the merchant kept quoting the old price.
   */
  const rowFor = (id: string): unknown => {
    const product = SEED_CATALOG.find((p) => p.id === id);
    if (!product) return undefined;
    const override = overrides[id] ?? {};
    return {
      sku: product.id,
      display_name: product.name,
      pricing: {
        // Decimal strings, the Shopify/GraphQL convention.
        retail: override.retail ?? (product.priceMinor / 100).toFixed(2),
        floor: (product.minPriceMinor / 100).toFixed(2),
      },
      warehouse: { on_hand: override.onHand ?? SEED_INVENTORY[product.id] ?? 0 },
      dietary: {
        // Comma delimited, and absent entirely when unknown — which is how the
        // truffle's genuinely-missing data has to survive the round trip.
        contains: product.allergens === null ? undefined : product.allergens.join(","),
        plant_based: product.vegan === null ? undefined : product.vegan,
      },
      can_bundle: product.bundleEligible,
    };
  };

  const fetcher: Fetcher = async (url) => {
    requests += 1;
    const ids = new URL(url).searchParams.get("skus")?.split(",") ?? [];
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { items: ids.map(rowFor).filter(Boolean) } }),
    };
  };

  return { fetcher, requestCount: () => requests };
}

const MAPPING = {
  merchant: "foreign",
  label: "Foreign REST catalogue",
  currency: "INR" as const,
  defaultCategory: "coffee" as const,
  transport: {
    kind: "rest" as const,
    baseUrl: "https://foreign.test",
    productPath: "/v2/catalogue/{id}",
    batch: { path: "/v2/catalogue", idsParam: "skus", root: "data.items" },
  },
  product: {
    id: "sku",
    name: "display_name",
    price: { path: "pricing.retail", unit: "decimalString" as const },
    minPrice: { path: "pricing.floor", unit: "decimalString" as const },
    allergens: { path: "dietary.contains", whenMissing: "unknown" as const, splitOn: "," },
    vegan: { path: "dietary.plant_based", whenMissing: "unknown" as const },
    bundleEligible: { path: "can_bundle", whenMissing: "false" as const },
  },
  inventory: { available: "warehouse.on_hand" },
  // No version fields anywhere, so both are synthesised from content.
  derive: {
    priceVersion: "observed" as const,
    inventoryVersion: "observed" as const,
  },
  supportsReservations: true,
};

function guardAgainstForeignMerchant(
  overrides?: Record<string, { retail?: string; onHand?: number }>,
) {
  const env = createEnvironment({});
  const { fetcher, requestCount } = foreignMerchant(overrides);
  const schema = parseMerchantSchema(MAPPING);
  const adapter = new MerchantAdapter(schema, transportFor(schema, fetcher));

  // One catalogue: the merchant is synchronised into local state rather than presented
  // as a rival view, so pricing and verification cannot disagree about versions.
  const source = new AdapterCatalogSource(adapter, env.state);

  const guard = env.guard;
  guard.setCatalogSource(source);
  guard.beginIntent(
    createIntent(env.ids, env.clock, {
      runId: "foreign",
      utterance: "a coffee hamper",
      maxBudget: 5000,
    }),
  );
  return { env, guard, adapter, source, requestCount };
}

describe("a full journey against a foreign REST catalogue", () => {
  it("prices a bundle from decimal strings without losing a paise", async () => {
    const { guard } = guardAgainstForeignMerchant();

    const bundle = await guard.callTool("create_bundle", {
      items: [
        { product_id: "p-coffee-arabica", quantity: 1 },
        { product_id: "p-mug-ceramic", quantity: 1 },
      ],
    });
    const bundleId = ok<{ bundle_id: string }>(bundle).bundle_id;

    const quote = await guard.callTool("create_quote", { bundle_id: bundleId });

    // ₹599 + ₹399, read as "599.00" and "399.00" over the wire.
    expect(ok<{ total: number }>(quote).total).toBe(998);
  });

  it("completes a clean journey with the Guard allowing every checkpoint", async () => {
    const { guard } = guardAgainstForeignMerchant();

    const bundle = await guard.callTool("create_bundle", {
      items: [{ product_id: "p-coffee-arabica", quantity: 1 }],
    });
    const quote = await guard.callTool("create_quote", {
      bundle_id: ok<{ bundle_id: string }>(bundle).bundle_id,
    });
    const quoteId = ok<{ quote_id: string }>(quote).quote_id;

    const approval = await guard.callTool("approve_quote", {
      quote_id: quoteId,
      approved_amount: 599,
      confirmation_text: "yes, buy it",
    });
    const receiptId = ok<{ approval_receipt_id: string }>(approval).approval_receipt_id;

    const checkout = await guard.callTool("create_checkout", {
      quote_id: quoteId,
      approval_receipt_id: receiptId,
    });
    expect(checkout.ok, checkout.ok ? "" : checkout.reason).toBe(true);

    // No violations from a correct integration, even though every product field was
    // translated from a foreign shape.
    expect(guard.recordedViolations()).toEqual([]);
  });

  it("still catches a mid-journey price move with no merchant version field", async () => {
    /**
     * The rule that could not have run at all against this merchant. It exposes no
     * price version, so INV-PRICE-BINDING would have been withheld — and had it been
     * allowed to run against undefined it would have compared undefined to undefined and
     * reported the price as still bound.
     *
     * Instead the engine versions the price by observation: it saw ₹599 at
     * quote.created, sees ₹649 at checkout.requested, bumps its own counter, and the
     * rule fires exactly as it does against HamperHub's native one.
     */
    const overrides: Record<string, { retail?: string }> = {};
    const { guard } = guardAgainstForeignMerchant(overrides);

    const bundle = await guard.callTool("create_bundle", {
      items: [{ product_id: "p-coffee-arabica", quantity: 1 }],
    });
    const quote = await guard.callTool("create_quote", {
      bundle_id: ok<{ bundle_id: string }>(bundle).bundle_id,
    });
    const quoteId = ok<{ quote_id: string }>(quote).quote_id;
    const approval = await guard.callTool("approve_quote", {
      quote_id: quoteId,
      approved_amount: 599,
      confirmation_text: "yes",
    });
    const receiptId = ok<{ approval_receipt_id: string }>(approval).approval_receipt_id;

    // The merchant re-prices between approval and checkout.
    overrides["p-coffee-arabica"] = { retail: "649.00" };

    const checkout = await guard.callTool("create_checkout", {
      quote_id: quoteId,
      approval_receipt_id: receiptId,
    });

    expect(checkout.ok).toBe(false);
    const fired = guard
      .recordedViolations()
      .map((v) => v.invariantId)
      .concat(guard.recordedEscalations().map((v) => v.invariantId));
    expect(fired).toContain("INV-PRICE-BINDING");
  });

  it("reads the whole basket in one request per checkpoint", async () => {
    /**
     * Six line items across five checkpoints is thirty single-product reads if nothing
     * batches. This mapping declares a batch endpoint, so each checkpoint is one call —
     * the difference between a correctness feature that survives and one removed for
     * being slow.
     */
    const { guard, requestCount } = guardAgainstForeignMerchant();

    const bundle = await guard.callTool("create_bundle", {
      items: [
        { product_id: "p-coffee-arabica", quantity: 1 },
        { product_id: "p-coffee-instant", quantity: 1 },
        { product_id: "p-mug-ceramic", quantity: 1 },
      ],
    });
    const before = requestCount();
    await guard.callTool("create_quote", {
      bundle_id: ok<{ bundle_id: string }>(bundle).bundle_id,
    });

    // One evaluation at quote.created, three products, one HTTP call.
    expect(requestCount() - before).toBe(1);
  });

  it("preserves genuinely-unknown allergen data across the translation", async () => {
    /**
     * The truffle ships with `allergens: null` — the merchant has not supplied the
     * data. The foreign shape omits the field entirely, and `whenMissing: "unknown"`
     * carries that through as null rather than collapsing it to "no allergens". If this
     * regressed, seeded defect #4 would stop being detectable and an allergic buyer
     * would be sold a product nobody had checked.
     */
    const { adapter } = guardAgainstForeignMerchant();
    const snapshot = await adapter.snapshot(["p-choc-truffle"]);
    const truffle = snapshot.getProduct("p-choc-truffle");

    expect(truffle?.allergens).toBeNull();
    expect(truffle?.vegan).toBeNull();
  });

  it("declares every capability, because the mapping fills every field", async () => {
    const { source } = guardAgainstForeignMerchant();
    const capabilities = source.capabilities();

    expect(capabilities.has("product.priceVersion")).toBe(true);
    expect(capabilities.has("inventory.version")).toBe(true);
    expect(capabilities.has("product.allergens")).toBe(true);
    expect(capabilities.has("reservation.lookup")).toBe(true);

    // But is honest that two of them are the engine's own bookkeeping rather than a
    // merchant guarantee.
    expect(source.derivedCapabilities()).toEqual([
      "product.priceVersion",
      "inventory.version",
    ]);
    expect(source.describe).toContain("derived");
  });
});

describe("a capability-poor merchant loses rules rather than passing them", () => {
  it("withholds price binding, inventory and safety for a bare price list", async () => {
    const bare = parseMerchantSchema({
      merchant: "bare",
      label: "Bare price list",
      currency: "INR",
      defaultCategory: "coffee",
      transport: {
        kind: "rest",
        baseUrl: "https://bare.test",
        productPath: "/p/{id}",
      },
      product: {
        id: "sku",
        name: "display_name",
        price: { path: "pricing.retail", unit: "decimalString" },
      },
    });

    const { fetcher } = foreignMerchant();
    const adapter = new MerchantAdapter(bare, transportFor(bare, fetcher));
    const capabilities = adapter.capabilities();

    expect(capabilities.has("product.priceVersion")).toBe(false);
    expect(capabilities.has("inventory.available")).toBe(false);
    expect(capabilities.has("product.allergens")).toBe(false);
    expect(adapter.derivedCapabilities()).toEqual([]);
  });

  it("reports the gap on the evaluation rather than passing the rule", async () => {
    /**
     * The end-to-end version of the whole argument. A merchant with no version field
     * must lose INV-PRICE-BINDING by name, not gain a green tick for it.
     */
    const bare = parseMerchantSchema({
      merchant: "bare",
      label: "Bare price list",
      currency: "INR",
      defaultCategory: "coffee",
      transport: {
        kind: "rest",
        baseUrl: "https://bare.test",
        productPath: "/v2/catalogue/{id}",
        batch: { path: "/v2/catalogue", idsParam: "skus", root: "data.items" },
      },
      product: {
        id: "sku",
        name: "display_name",
        price: { path: "pricing.retail", unit: "decimalString" },
      },
    });

    const env = createEnvironment({});
    const { fetcher } = foreignMerchant();
    const adapter = new MerchantAdapter(bare, transportFor(bare, fetcher));
    env.guard.setCatalogSource(new AdapterCatalogSource(adapter, env.state));
    env.guard.beginIntent(
      createIntent(env.ids, env.clock, {
        runId: "bare",
        utterance: "coffee",
        maxBudget: 5000,
      }),
    );

    const bundle = await env.guard.callTool("create_bundle", {
      items: [{ product_id: "p-coffee-arabica", quantity: 1 }],
    });
    await env.guard.callTool("create_quote", {
      bundle_id: ok<{ bundle_id: string }>(bundle).bundle_id,
    });

    const evaluation = env.guard.allEvaluations()[0];
    expect(evaluation?.unsupportedCount).toBeGreaterThan(0);
    const withheld = evaluation?.capabilityGaps.map((g) => g.invariantId) ?? [];
    expect(withheld).toContain("INV-INVENTORY");
    expect(withheld).toContain("INV-PRODUCT-SAFETY");
  });
});
