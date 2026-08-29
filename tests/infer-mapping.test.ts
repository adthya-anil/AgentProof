import { describe, expect, it } from "vitest";
import type { CompletionRequest, CompletionResult, LLM } from "../src/lib/agent/llm.js";
import { inferMapping, validateAgainstSample } from "../src/lib/merchant/infer.js";
import { type MerchantSchema, parseMerchantSchema } from "../src/lib/merchant/mapping.js";

/**
 * Letting a model write the mapping, without letting it decide anything.
 *
 * The mapping says which field is the price. If a model's word were enough, a
 * hallucinated path would produce confident verdicts about the wrong amount of money —
 * the exact failure the rest of this product refuses. So the model proposes and
 * deterministic validation decides, and these tests are about validation having teeth.
 *
 * A real model is exercised by `npm run demo:infer`. Everything here uses canned replies,
 * because a test that needs a network and a key is a test that gets skipped.
 */

/** Answers with whatever JSON the test wants to pretend a model returned. */
function fakeLlm(reply: unknown): LLM {
  return {
    name: "fake",
    isReal: true,
    async complete(_request: CompletionRequest): Promise<CompletionResult> {
      return {
        content: typeof reply === "string" ? reply : JSON.stringify(reply),
        toolCalls: [],
        model: "fake",
      };
    },
  };
}

const TRANSPORT = {
  kind: "graphql" as const,
  endpoint: "https://shop.test/graphql",
  query: "query($ids:[ID!]!){ products(ids:$ids){ id } }",
  root: "products",
  headers: {},
};

/** Two products, the second missing its allergen field — as real catalogues are. */
const SAMPLE = {
  data: {
    products: [
      {
        id: "NW-1001",
        title: "Nordic Roast Filter Coffee 250g",
        pricing: { unit: { amount: "649.00" }, floor: { amount: "580.00" } },
        availability: { quantity: 12 },
        dietary: { contains: "", tags: ["PLANT_BASED"] },
      },
      {
        id: "NW-1005",
        title: "Stoneware Pour-Over Mug",
        pricing: { unit: { amount: "515.00" }, floor: { amount: "480.00" } },
        availability: { quantity: 3 },
        dietary: { tags: [] },
      },
    ],
  },
};

const GOOD_PROPOSAL = {
  product: {
    id: "id",
    name: "title",
    price: { path: "pricing.unit.amount", unit: "decimalString" },
    minPrice: { path: "pricing.floor.amount", unit: "decimalString" },
    allergens: { path: "dietary.contains", whenMissing: "unknown", splitOn: "," },
    vegan: { path: "dietary.tags", whenMissing: "unknown", truthy: ["PLANT_BASED"] },
  },
  inventory: { available: "availability.quantity" },
  defaultCategory: "coffee",
  notes: "Amounts are decimal strings.",
};

async function infer(proposal: unknown) {
  return inferMapping({
    llm: fakeLlm(proposal),
    merchant: "test",
    label: "Test merchant",
    transport: TRANSPORT,
    sample: SAMPLE,
    requestedIds: ["NW-1001", "NW-1005"],
  });
}

describe("a sound proposal is accepted, and proved rather than trusted", () => {
  it("accepts a mapping that builds real products from the sample", async () => {
    const result = await infer(GOOD_PROPOSAL);
    expect(result.ok, result.ok ? "" : result.problems.join("; ")).toBe(true);
    if (!result.ok) return;

    expect(result.schema.product.price.path).toBe("pricing.unit.amount");
    // Acceptance means an entity was actually constructed, not that the JSON parsed.
    expect(result.product.priceMinor).toBe(64900);
    expect(result.product.name).toBe("Nordic Roast Filter Coffee 250g");
  });

  it("surfaces the price as a formatted amount for a human to confirm", async () => {
    /**
     * The one thing validation cannot settle. Nothing in "649.00" says whether the
     * merchant means ₹649.00 or ₹6.49 — both readings are self-consistent, and a wrong
     * one is a hundredfold error in the only quantity that matters. So it is shown, not
     * assumed.
     */
    const result = await infer(GOOD_PROPOSAL);
    expect(result.ok && result.priceForReview).toBe("₹649.00");
  });

  it("derives capabilities from the proposal rather than letting it claim them", async () => {
    const result = await infer(GOOD_PROPOSAL);
    expect(result.ok && result.capabilities).toContain("product.allergens");
    expect(result.ok && result.capabilities).toContain("inventory.available");
    // Nothing in the proposal claimed reservations, so nothing claims them now.
    expect(result.ok && result.capabilities).not.toContain("reservation.lookup");
  });

  it("keeps versions as the engine's own counters, not a path the model liked", async () => {
    /**
     * Validation can prove a path resolves. It cannot prove the value ever *changes*,
     * which is the only property a version needs. So `observed` is forced and reported as
     * derived, rather than trusting a field the model believed was a version.
     */
    const result = await infer(GOOD_PROPOSAL);
    expect(result.ok && result.schema.derive.priceVersion).toBe("observed");
    expect(result.ok && result.derivedCapabilities).toContain("product.priceVersion");
  });
});

describe("validation rejects what it cannot verify", () => {
  it("rejects a path the merchant does not have", async () => {
    const result = await infer({
      ...GOOD_PROPOSAL,
      product: { ...GOOD_PROPOSAL.product, name: "product_title" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join(" ")).toMatch(/product_title.*resolves to nothing/);
  });

  it("rejects paths rooted at the response rather than a product", async () => {
    /**
     * Not hypothetical: a real model did exactly this on the first attempt, answering
     * `data.products[1].id` because it had been shown the whole envelope. The prompt now
     * passes one product at a time, and this is the net underneath that.
     */
    const result = await infer({
      ...GOOD_PROPOSAL,
      product: {
        ...GOOD_PROPOSAL.product,
        id: "data.products[1].id",
        name: "data.products[1].title",
      },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a unit that contradicts the value it reads", async () => {
    // "649.00" cannot be minor units. Accepting it would price a ₹649 coffee at ₹6.49.
    const result = await infer({
      ...GOOD_PROPOSAL,
      product: {
        ...GOOD_PROPOSAL.product,
        price: { path: "pricing.unit.amount", unit: "minor" },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join(" ")).toMatch(/decimal point/);
  });

  it("rejects an id path that does not produce the ids requested", async () => {
    /**
     * A plausible-looking wrong id path yields a catalogue that resolves nothing, which
     * surfaces much later as "the merchant has none of these products" rather than as a
     * bad mapping.
     */
    const result = await infer({
      ...GOOD_PROPOSAL,
      product: { ...GOOD_PROPOSAL.product, id: "title" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join(" ")).toMatch(/none of which match the ids requested/);
  });

  it("rejects stock mapped to something that is not a count", async () => {
    const withBoolean = {
      data: {
        products: [
          { ...SAMPLE.data.products[0], availability: { quantity: true } },
        ],
      },
    };
    const result = await inferMapping({
      llm: fakeLlm(GOOD_PROPOSAL),
      merchant: "test",
      label: "Test",
      transport: TRANSPORT,
      sample: withBoolean,
      requestedIds: ["NW-1001"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join(" ")).toMatch(/boolean cannot answer how many remain/);
  });

  it("rejects a reply that is not JSON at all", async () => {
    const result = await infer("I think the price is probably in pricing.unit.amount.");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join(" ")).toMatch(/parseable JSON/);
  });

  it("rejects a proposal that fails the schema, listing every fault at once", async () => {
    // One round trip should be enough to fix everything wrong with a proposal.
    const result = await infer({
      product: { id: "id", name: "title", price: { path: "pricing.unit.amount" } },
      defaultCategory: "beverages",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.length).toBeGreaterThan(1);
  });

  it("reads JSON out of a fenced code block", async () => {
    // Models asked for JSON still fence it often enough that failing would be flaky
    // for no reason worth defending.
    const result = await infer(
      "```json\n" + JSON.stringify(GOOD_PROPOSAL) + "\n```",
    );
    expect(result.ok).toBe(true);
  });
});

describe("absence is not the same as a wrong path", () => {
  it("accepts a tolerant field missing from some products but not others", async () => {
    /**
     * The regression that matters most here. `dietary.contains` is genuinely absent on
     * the mug and present on the coffee, and `whenMissing: "unknown"` exists precisely to
     * carry that difference. An earlier version checked every path against the first row
     * and rejected a correct mapping — the merchant's honest gap read as the model's
     * mistake.
     */
    const result = await infer(GOOD_PROPOSAL);
    expect(result.ok, result.ok ? "" : result.problems.join("; ")).toBe(true);
  });

  it("rejects a tolerant field absent from every product", async () => {
    // Tolerating absence everywhere would let the model invent a field and derive a
    // capability from it, which is how a rule gets counted as covered while reading null.
    const result = await infer({
      ...GOOD_PROPOSAL,
      product: {
        ...GOOD_PROPOSAL.product,
        allergens: { path: "dietary.allergenList", whenMissing: "unknown" },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join(" ")).toMatch(/on any of the/);
  });

  it("rejects a required field missing from even one product", async () => {
    /**
     * Split from the tolerant case because the adapter treats them differently: readMoney
     * throws on an absent price, so a mapping that works on the first product and dies on
     * the second must not pass. Checking only one row would have shipped exactly that.
     */
    const oneMissingPrice = {
      data: {
        products: [
          SAMPLE.data.products[0],
          { id: "NW-1005", title: "Mug", availability: { quantity: 3 }, dietary: {} },
        ],
      },
    };
    const result = await validateAgainstSample(
      parseMerchantSchema({
        merchant: "t",
        label: "T",
        currency: "INR",
        defaultCategory: "coffee",
        transport: TRANSPORT,
        product: {
          id: "id",
          name: "title",
          price: { path: "pricing.unit.amount", unit: "decimalString" },
        },
        inventory: { available: "availability.quantity" },
      }),
      oneMissingPrice,
      ["NW-1001", "NW-1005"],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join(" ")).toMatch(/cannot be absent/);
  });
});


describe("inference replaces the field mappings and nothing else", () => {
  /**
   * Everything a model cannot read off one response, declared once.
   *
   * A sample shows what a listing returns. It cannot show how to ask for a listing, whether
   * the merchant will let you move a price, or whether it holds stock — those are
   * configuration, and inference has to carry them through untouched.
   */
  const BASE = parseMerchantSchema({
    merchant: "declared",
    label: "Declared",
    currency: "INR",
    transport: TRANSPORT,
    catalogue: {
      listQuery: "query { catalogue { id } }",
      listPath: "catalogue",
    },
    admin: {
      setPrice: {
        mutation: "mutation($id:ID!,$m:Int!){ setMerchantPrice(id:$id, minor:$m) }",
        variables: { id: "$productId", m: "$amountMinor" },
      },
      setStock: {
        mutation: "mutation($id:ID!,$q:Int!){ setMerchantStock(id:$id, qty:$q) }",
        variables: { id: "$productId", q: "$quantity" },
      },
    },
    supportsReservations: true,
    /**
     * A deliberately different price path from the one the model proposes, so "carried
     * through" and "overridden" can be told apart.
     */
    product: {
      id: "id",
      name: "title",
      price: { path: "wrong.place", unit: "minor" },
    },
    inventory: {},
    defaultCategory: "coffee",
  });

  async function inferWith(base: MerchantSchema | undefined) {
    return inferMapping({
      llm: fakeLlm(GOOD_PROPOSAL),
      merchant: "third-party",
      label: "Third-party",
      transport: TRANSPORT,
      sample: SAMPLE,
      requestedIds: ["NW-1001", "NW-1002"],
      base,
    });
  }

  /**
   * The regression that cost two journeys.
   *
   * `admin` was dropped on the way through inference, so a merchant with working mutations
   * reported "this merchant's prices cannot be moved" and the price-drift and stock-out
   * journeys came back untestable. It produced a plausible sentence instead of an error,
   * which is why it survived a green suite and a passing typecheck. Same shape as `catalogue`
   * being dropped before it — so this pins every field of the class at once.
   */
  it("carries admin mutations through, so the merchant stays perturbable", async () => {
    const result = await inferWith(BASE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.schema.admin?.setPrice?.mutation).toContain("setMerchantPrice");
    expect(result.schema.admin?.setStock?.mutation).toContain("setMerchantStock");
  });

  it("carries catalogue enumeration through, so journeys can browse", async () => {
    const result = await inferWith(BASE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.schema.catalogue?.listQuery).toContain("catalogue");
  });

  it("carries reservation support through rather than assuming it away", async () => {
    const result = await inferWith(BASE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.schema.supportsReservations).toBe(true);
  });

  /**
   * The inferred half still wins where it should. Configuration is carried, not preferred —
   * a base that named the wrong price path must not override what the model actually found.
   */
  it("still lets the inferred field mappings replace the declared ones", async () => {
    const result = await inferWith(BASE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The proposed price path wins over the base's deliberately wrong one.
    expect(result.schema.product.price.path).toBe("pricing.unit.amount");
    // Present in the proposal, absent from the base.
    expect(result.schema.product.allergens?.path).toBe("dietary.contains");
    expect(result.schema.inventory?.available).toBe("availability.quantity");
  });

  /**
   * A merchant mapped from nothing is still mappable — it simply has none of the
   * capabilities, and the engine withholds the rules that need them rather than inventing
   * a pass.
   */
  it("works with no base at all, claiming no capabilities", async () => {
    const result = await inferWith(undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.schema.admin?.setPrice).toBeUndefined();
    expect(result.schema.admin?.setStock).toBeUndefined();
    expect(result.schema.catalogue?.listQuery).toBeUndefined();
    expect(result.schema.supportsReservations).toBe(false);
  });

  /**
   * Versions stay observed even when the base declared otherwise. The engine's own counter
   * catches a price moving A→B→A, which a field the model believed was a version cannot be
   * shown to do.
   */
  it("keeps versions observed regardless of what the base said", async () => {
    const result = await inferWith(BASE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.schema.derive?.priceVersion).toBe("observed");
    expect(result.schema.derive?.inventoryVersion).toBe("observed");
  });
});
