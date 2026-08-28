import { describe, expect, it, beforeEach } from "vitest";
import { POST } from "../src/app/api/merchant/nordwell/route.js";
import type { ToolResult } from "../src/lib/guard/guard.js";
import { createEnvironment, createIntent } from "../src/lib/harness.js";
import { MerchantAdapter } from "../src/lib/merchant/adapter.js";
import { parseMerchantSchema } from "../src/lib/merchant/mapping.js";
import { AdapterCatalogSource } from "../src/lib/merchant/source.js";
import { transportFor, type Fetcher } from "../src/lib/merchant/transport.js";
import { NORDWELL_MAPPING, resetNordwell } from "../src/lib/merchants/nordwell.js";

/**
 * Nordwell Provisions — the second merchant.
 *
 * The adapter's claim is that the twelve invariants no longer depend on HamperHub's
 * shape. Everything before this proved it against a test double, which cannot settle the
 * question: the double and the engine share an author, a moment, and a set of
 * assumptions. Nordwell is a separate service with its own data model, and running the
 * real rules against it found two bugs no unit test had — a tag list read as
 * not-vegan, and a cross-process re-price that never happened.
 *
 * The route handler is called directly rather than over a socket, so CI needs no server.
 * The protocol is still real: JSON in, GraphQL errors out, rows in the server's own
 * order.
 */

/** Routes the adapter's HTTP calls into the real route handler, in-process. */
const routeFetcher: Fetcher = async (url, init) => {
  const request = new Request(url, {
    method: init?.method ?? "POST",
    headers: init?.headers,
    body: init?.body,
  });
  const response = await POST(request as never);
  return {
    ok: response.ok,
    status: response.status,
    json: () => response.json(),
  };
};

const SCHEMA = parseMerchantSchema(NORDWELL_MAPPING);

function nordwell() {
  const env = createEnvironment({});
  const adapter = new MerchantAdapter(SCHEMA, transportFor(SCHEMA, routeFetcher));
  const source = new AdapterCatalogSource(adapter, env.state);
  return { env, adapter, source };
}

async function graphql(query: string, variables: Record<string, unknown> = {}) {
  const response = await POST(
    new Request("http://test/api/merchant/nordwell", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    }) as never,
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function ok<T>(result: ToolResult): T {
  if (!result.ok) throw new Error(`expected success, got: ${result.reason}`);
  return result.data as T;
}

beforeEach(() => {
  resetNordwell();
});

describe("Nordwell speaks GraphQL, including when it fails", () => {
  it("answers a products query", async () => {
    const { body } = await graphql(
      "query($ids:[ID!]!){ products(ids:$ids){ id title } }",
      { ids: ["NW-1001"] },
    );
    const products = (body.data as { products: unknown[] }).products;
    expect(products).toHaveLength(1);
  });

  it("reports an unknown field as a GraphQL error with HTTP 200", async () => {
    /**
     * The trap this exists to pin. GraphQL signals failure with an `errors` array beside
     * a partial `data`, at status 200 — so a transport checking only the status would
     * map whatever survived and report it as the catalogue.
     */
    const { status, body } = await graphql("query { somethingElse { id } }");
    expect(status).toBe(200);
    expect(body.errors).toBeDefined();
  });

  it("rejects a missing required variable", async () => {
    const { body } = await graphql("query($ids:[ID!]!){ products(ids:$ids){ id } }");
    expect(body.errors).toBeDefined();
  });

  it("omits ids it does not have rather than returning nulls", async () => {
    const { body } = await graphql(
      "query($ids:[ID!]!){ products(ids:$ids){ id } }",
      { ids: ["NW-1001", "NW-9999"] },
    );
    const products = (body.data as { products: Array<{ id: string }> }).products;
    expect(products.map((p) => p.id)).toEqual(["NW-1001"]);
  });

  it("answers in its own order, not the order asked", async () => {
    // Deliberate. A merchant is under no obligation to preserve request order, and a
    // client zipping by index would attribute one product's price to another.
    const { body } = await graphql(
      "query($ids:[ID!]!){ products(ids:$ids){ id } }",
      { ids: ["NW-1001", "NW-1005"] },
    );
    const products = (body.data as { products: Array<{ id: string }> }).products;
    expect(products.map((p) => p.id)).toEqual(["NW-1005", "NW-1001"]);
  });

  it("refuses GET", async () => {
    const { GET } = await import("../src/app/api/merchant/nordwell/route.js");
    expect((await GET()).status).toBe(405);
  });
});

describe("the adapter reads Nordwell correctly despite the shape", () => {
  it("matches reversed rows back to the ids requested", async () => {
    // The server answers reversed; if this zipped by position, the mug's ₹515 would be
    // attributed to the coffee.
    const { adapter } = nordwell();
    const snapshot = await adapter.snapshot(["NW-1001", "NW-1005"]);
    expect(snapshot.getProduct("NW-1001")?.priceMinor).toBe(64900);
    expect(snapshot.getProduct("NW-1005")?.priceMinor).toBe(51500);
  });

  it("parses decimal-string money exactly", async () => {
    // "429.50" — the half-rupee is where a float would betray itself.
    const { adapter } = nordwell();
    const snapshot = await adapter.snapshot(["NW-1002"]);
    expect(snapshot.getProduct("NW-1002")?.priceMinor).toBe(42950);
  });

  it("reads vegan from a tag list rather than a boolean", async () => {
    /**
     * The bug the real merchant found. `tags: ["PLANT_BASED"]` was compared against the
     * truthy list as a whole array, never matched, and every tagged product read as
     * not-vegan — which makes INV-PRODUCT-SAFETY reject a *correct* integration. A false
     * violation, and no unit test had a tag list in it because the fixtures came from
     * the same assumption as the code.
     */
    const { adapter } = nordwell();
    const snapshot = await adapter.snapshot(["NW-1001", "NW-1003"]);
    expect(snapshot.getProduct("NW-1001")?.vegan).toBe(true);
    expect(snapshot.getProduct("NW-1003")?.vegan).toBe(false);
  });

  it("keeps an absent allergen field unknown, not empty", async () => {
    /**
     * NW-1004 has no `dietary.contains` at all — Nordwell does not track allergens for
     * that line. Reading it as "allergen-free" is how a hazelnut praline gets sold to
     * someone with a nut allergy.
     */
    const { adapter } = nordwell();
    const snapshot = await adapter.snapshot(["NW-1003", "NW-1004"]);
    expect(snapshot.getProduct("NW-1003")?.allergens).toEqual(["milk", "soy"]);
    expect(snapshot.getProduct("NW-1004")?.allergens).toBeNull();
  });

  it("distinguishes an empty allergen string from a missing one", async () => {
    // NW-1001 declares `contains: ""` — checked, and nothing found. Different from
    // NW-1004, which was never checked.
    const { adapter } = nordwell();
    const snapshot = await adapter.snapshot(["NW-1001"]);
    expect(snapshot.getProduct("NW-1001")?.allergens).toEqual([]);
  });

  it("translates collections into the entity model's closed category set", async () => {
    const { adapter } = nordwell();
    const snapshot = await adapter.snapshot(["NW-1001", "NW-1003", "NW-1005", "NW-1006"]);
    expect(snapshot.getProduct("NW-1001")?.category).toBe("coffee");
    expect(snapshot.getProduct("NW-1003")?.category).toBe("chocolate");
    expect(snapshot.getProduct("NW-1005")?.category).toBe("mug");
    expect(snapshot.getProduct("NW-1006")?.category).toBe("packaging");
  });

  it("reads the whole basket in one GraphQL round trip", async () => {
    let calls = 0;
    const counting: Fetcher = async (url, init) => {
      calls += 1;
      return routeFetcher(url, init);
    };
    const adapter = new MerchantAdapter(SCHEMA, transportFor(SCHEMA, counting));
    await adapter.snapshot(["NW-1001", "NW-1002", "NW-1003", "NW-1005"]);
    expect(calls).toBe(1);
  });
});

describe("capabilities Nordwell actually has", () => {
  it("declares seven of eight, and not reservations", async () => {
    const { source } = nordwell();
    const capabilities = source.capabilities();

    expect(capabilities.size).toBe(7);
    // The one that matters: Nordwell's catalogue is read-only and cannot hold stock.
    expect(capabilities.has("reservation.lookup")).toBe(false);
  });

  it("is honest that both versions are the engine's own bookkeeping", async () => {
    const { source } = nordwell();
    expect(source.derivedCapabilities()).toEqual([
      "product.priceVersion",
      "inventory.version",
    ]);
    expect(source.describe).toContain("graphql");
  });
});

describe("the twelve rules against a merchant they were not written for", () => {
  async function journey() {
    const { env, source } = nordwell();
    const ids = ["NW-1001", "NW-1005"];
    await source.prime(ids);

    const guard = env.guard;
    guard.setCatalogSource(source);
    guard.beginIntent(
      createIntent(env.ids, env.clock, {
        runId: "nordwell",
        utterance: "a coffee gift set",
        maxBudget: 2000,
      }),
    );

    const bundle = await guard.callTool("create_bundle", {
      items: ids.map((id) => ({ product_id: id, quantity: 1 })),
    });
    const quote = await guard.callTool("create_quote", {
      bundle_id: ok<{ bundle_id: string }>(bundle).bundle_id,
    });
    const priced = ok<{ quote_id: string; total: number }>(quote);
    const approval = await guard.callTool("approve_quote", {
      quote_id: priced.quote_id,
      approved_amount: priced.total,
      confirmation_text: "yes",
    });
    return {
      guard,
      priced,
      receiptId: ok<{ approval_receipt_id: string }>(approval).approval_receipt_id,
    };
  }

  it("passes a clean journey with no violations", async () => {
    const { guard, priced, receiptId } = await journey();

    // ₹649.00 + ₹515.00, both read as decimal strings over GraphQL.
    expect(priced.total).toBe(1164);

    const checkout = await guard.callTool("create_checkout", {
      quote_id: priced.quote_id,
      approval_receipt_id: receiptId,
    });
    expect(checkout.ok, checkout.ok ? "" : checkout.reason).toBe(true);
    expect(guard.recordedViolations()).toEqual([]);
  });

  it("withholds the inventory rule by name instead of passing it", async () => {
    /**
     * The whole point of the capability layer, on a real merchant. Nordwell has no
     * reservations, so INV-INVENTORY cannot run — and must be reported as not run rather
     * than counted as a pass, which is what would have happened had it been allowed to
     * compare a reservation id that cannot exist.
     */
    const { guard } = await journey();
    const withheld = new Set(
      guard.allEvaluations().flatMap((e) => e.capabilityGaps.map((g) => g.invariantId)),
    );
    expect(withheld.has("INV-INVENTORY")).toBe(true);

    // And it is not silently counted among the rules that ruled on anything.
    const evaluation = guard.allEvaluations()[0];
    expect(evaluation?.unsupportedCount).toBeGreaterThan(0);
  });

  it("catches a merchant re-price with no merchant version field", async () => {
    /**
     * Nordwell exposes no price version at all. The engine noticed anyway, because it
     * remembers what it last read — and this is the case that would have been an
     * undetected escape if the rule had been allowed to compare undefined to undefined.
     */
    const { guard, priced, receiptId } = await journey();

    await graphql(
      "mutation($id:ID!,$amount:String!){ setPrice(id:$id,amount:$amount){ id } }",
      { id: "NW-1001", amount: "699.00" },
    );

    const checkout = await guard.callTool("create_checkout", {
      quote_id: priced.quote_id,
      approval_receipt_id: receiptId,
    });

    expect(checkout.ok).toBe(false);
    const fired = guard
      .recordedViolations()
      .concat(guard.recordedEscalations())
      .map((v) => v.invariantId);
    expect(fired).toContain("INV-PRICE-BINDING");
  });

  it("notices a price that moved and moved back, which a hash could not", async () => {
    /**
     * The concrete gain from versioning by observation rather than hashing content.
     * ₹649 → ₹699 → ₹649 leaves the price identical, so a content hash is unchanged and
     * the drift is invisible; a monotonic counter has advanced twice and the quote is
     * correctly stale.
     */
    const { guard, priced, receiptId } = await journey();

    await graphql(
      "mutation($id:ID!,$amount:String!){ setPrice(id:$id,amount:$amount){ id } }",
      { id: "NW-1001", amount: "699.00" },
    );

    /**
     * A real read in between, because the guarantee is exactly that narrow.
     *
     * The first version of this test used a call that throws before evaluation, so no
     * checkpoint ran, the engine never saw ₹699, and the checkout was correctly allowed —
     * the test was asserting a claim stronger than the one the design makes. The engine
     * observes changes between *its own reads*; a second quote is such a read.
     */
    const interim = await guard.callTool("create_bundle", {
      items: [{ product_id: "NW-1001", quantity: 1 }],
    });
    await guard.callTool("create_quote", {
      bundle_id: ok<{ bundle_id: string }>(interim).bundle_id,
    });

    await graphql(
      "mutation($id:ID!,$amount:String!){ setPrice(id:$id,amount:$amount){ id } }",
      { id: "NW-1001", amount: "649.00" },
    );

    const checkout = await guard.callTool("create_checkout", {
      quote_id: priced.quote_id,
      approval_receipt_id: receiptId,
    });

    // The price is back to what was quoted, but the catalogue demonstrably moved.
    expect(checkout.ok).toBe(false);
  });
});
