import { describe, expect, it } from "vitest";
import { createEnvironment, prepareEnvironment } from "../src/lib/harness.js";
import type { MerchantState } from "../src/lib/hamperhub/state.js";
import { MerchantAdapter, type CatalogTransport } from "../src/lib/merchant/adapter.js";
import { parseMerchantSchema } from "../src/lib/merchant/mapping.js";
import { AdapterCatalogSource, LocalCatalogSource } from "../src/lib/merchant/source.js";
import { GraphQLTransport, type Fetcher } from "../src/lib/merchant/transport.js";

/**
 * Running a suite against a mapped merchant, rather than only verifying one.
 *
 * The mapping's purpose is to let a merchant be *tested* — to answer "is this shop safe
 * for an autonomous buyer". Until the runner could be pointed at one, a mapping bought the
 * ability to check a quote and nothing else, which is a fraction of the point.
 *
 * Two things were missing and both are covered here: a way for an agent to browse a mapped
 * catalogue, and a seam that binds a run to a merchant. The second has a trap in it that
 * cost a whole misleading run, so it gets its own test.
 */

const BASE = {
  merchant: "shop",
  label: "Shop",
  currency: "INR" as const,
  defaultCategory: "coffee" as const,
  transport: {
    kind: "graphql" as const,
    endpoint: "https://shop.test/graphql",
    query: "query($ids:[ID!]!){ products(ids:$ids){ id } }",
    root: "products",
  },
  product: {
    id: "id",
    name: "title",
    price: { path: "price", unit: "decimalString" as const },
  },
  inventory: { available: "stock" },
};

const ROWS = [
  { id: "A-1", title: "Alpha", price: "100.00", stock: 5 },
  { id: "A-2", title: "Beta", price: "250.50", stock: 2 },
];

function fetcherFor(body: unknown): { fetcher: Fetcher; bodies: string[] } {
  const bodies: string[] = [];
  const fetcher: Fetcher = async (_url, init) => {
    bodies.push(init?.body ?? "");
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetcher, bodies };
}

/** Serves ROWS for fetch-by-id, and can list them. */
function cannedTransport(): CatalogTransport {
  return {
    kind: "canned",
    async fetch(ids) {
      const out = new Map<string, unknown>();
      for (const row of ROWS) if (ids.includes(row.id)) out.set(row.id, row);
      return out;
    },
    async list() {
      return ROWS;
    },
  };
}

describe("a merchant can be browsed, not only queried by id", () => {
  it("returns the ids a mapping states outright", async () => {
    /**
     * Explicit ids beat a listing endpoint when both exist: they are a statement about
     * what is under test, which a listing is not.
     */
    const schema = parseMerchantSchema({
      ...BASE,
      catalogue: { ids: ["A-2", "A-1"] },
    });
    const adapter = new MerchantAdapter(schema, cannedTransport());
    expect(await adapter.listIds()).toEqual(["A-2", "A-1"]);
  });

  it("reads a listing operation when there is no explicit set", async () => {
    const schema = parseMerchantSchema({
      ...BASE,
      catalogue: { listQuery: "query All { products { id } }", root: "products" },
    });
    const adapter = new MerchantAdapter(schema, cannedTransport());
    expect(await adapter.listIds()).toEqual(["A-1", "A-2"]);
  });

  it("de-duplicates a listing that repeats an id", async () => {
    const schema = parseMerchantSchema({
      ...BASE,
      catalogue: { listQuery: "query All { products { id } }" },
    });
    const adapter = new MerchantAdapter(schema, {
      kind: "dupes",
      async fetch() {
        return new Map();
      },
      async list() {
        return [ROWS[0], ROWS[0], ROWS[1]];
      },
    });
    expect(await adapter.listIds()).toEqual(["A-1", "A-2"]);
  });

  it("refuses to pretend an unlistable merchant has an empty catalogue", async () => {
    /**
     * The failure that matters. An empty list would run a whole suite against a shop with
     * nothing in it — every journey inconclusive, and a report that looks like a result.
     * Saying what is missing is the only useful answer.
     */
    const adapter = new MerchantAdapter(
      parseMerchantSchema(BASE),
      cannedTransport(),
    );
    await expect(adapter.listIds()).rejects.toThrow(/no way to enumerate its catalogue/);
  });

  it("says so when the transport cannot list at all", async () => {
    const schema = parseMerchantSchema({
      ...BASE,
      catalogue: { listQuery: "query All { products { id } }" },
    });
    const adapter = new MerchantAdapter(schema, {
      kind: "fetch-only",
      async fetch() {
        return new Map();
      },
    });
    await expect(adapter.listIds()).rejects.toThrow(/cannot list a catalogue/);
  });

  it("reports a listing whose ids do not resolve, rather than returning none", async () => {
    // A wrong id path yields an empty catalogue, which is indistinguishable from an empty
    // shop unless it is called out.
    const schema = parseMerchantSchema({
      ...BASE,
      product: { ...BASE.product, id: "sku" },
      catalogue: { listQuery: "query All { products { id } }" },
    });
    const adapter = new MerchantAdapter(schema, cannedTransport());
    await expect(adapter.listIds()).rejects.toThrow(/no ids resolved at 'sku'/);
  });

  it("lists over real GraphQL, treating errors beside a 200 as failure", async () => {
    const { fetcher } = fetcherFor({
      data: { products: null },
      errors: [{ message: "throttled" }],
    });
    const transport = new GraphQLTransport(
      parseMerchantSchema(BASE).transport as never,
      "id",
      fetcher,
    );
    await expect(transport.list("query All { products { id } }")).rejects.toThrow(
      /throttled/,
    );
  });

  it("sends the listing operation, not the fetch-by-id query", async () => {
    const { fetcher, bodies } = fetcherFor({ data: { products: ROWS } });
    const transport = new GraphQLTransport(
      parseMerchantSchema(BASE).transport as never,
      "id",
      fetcher,
    );
    await transport.list("query All { products { id } }");
    expect(JSON.parse(bodies[0] ?? "{}").query).toContain("query All");
  });
});

describe("pointing a run at a merchant", () => {
  it("loads the merchant's catalogue onto the shelves the agent searches", async () => {
    /**
     * The whole seam in one assertion. `search_products` reads local state, so an
     * environment that has not been primed shows the agent HamperHub's shelves no matter
     * which mapping is configured — and that failure is invisible, because the journey
     * runs and the invariants pass while describing a merchant nobody tested.
     */
    const schema = parseMerchantSchema({
      ...BASE,
      catalogue: { listQuery: "query All { products { id } }" },
    });
    const adapter = new MerchantAdapter(schema, cannedTransport());

    const env = createEnvironment({
      catalog: (state) => new AdapterCatalogSource(adapter, state),
    });
    await prepareEnvironment(env);

    const shelves = env.state.listProducts().map((p) => p.id);
    expect(shelves).toEqual(["A-1", "A-2"]);
    // And HamperHub is gone, rather than merged in alongside.
    expect(shelves).not.toContain("p-coffee-arabica");
  });

  it("prices from the merchant's own amounts", async () => {
    const schema = parseMerchantSchema({
      ...BASE,
      catalogue: { listQuery: "query All { products { id } }" },
    });
    const adapter = new MerchantAdapter(schema, cannedTransport());
    const env = createEnvironment({
      catalog: (state) => new AdapterCatalogSource(adapter, state),
    });
    await prepareEnvironment(env);

    // "250.50" over the wire, half a rupee intact.
    expect(env.state.getProduct("A-2")?.priceMinor).toBe(25050);
  });

  it("binds each environment's source to that environment's own state", async () => {
    /**
     * The trap this design exists to close, and it cost a full misleading run.
     *
     * A `CatalogSource` holds the state it syncs into. Passing one pre-built instance to a
     * suite meant every journey shared a source bound to a state object none of them
     * owned: quotes were priced from one catalogue and verified against another, so every
     * journey tripped INV-PRICE-BINDING — including the clean one — and the run reported
     * six unsafe violations and NOT READY. That reads exactly like a real finding about
     * the merchant.
     *
     * Taking a factory makes it unexpressible, and this test is what keeps it that way.
     */
    const schema = parseMerchantSchema({
      ...BASE,
      catalogue: { listQuery: "query All { products { id } }" },
    });
    const adapter = new MerchantAdapter(schema, cannedTransport());
    const factory = (state: MerchantState) => new AdapterCatalogSource(adapter, state);

    const first = createEnvironment({ catalog: factory });
    const second = createEnvironment({ catalog: factory });
    await prepareEnvironment(first);
    await prepareEnvironment(second);

    // Two runs, two catalogues, no shared mutable state between them.
    first.state.setPrice("A-1", 99900, "test");
    expect(first.state.getProduct("A-1")?.priceMinor).toBe(99900);
    expect(second.state.getProduct("A-1")?.priceMinor).toBe(10000);
  });

  it("leaves an unprimed environment on HamperHub, and says nothing has changed", async () => {
    // No catalog option means the in-process merchant, which is every existing run.
    const env = createEnvironment({});
    await prepareEnvironment(env);
    expect(env.state.getProduct("p-coffee-arabica")).toBeDefined();
    expect(env.catalog).toBeUndefined();
  });

  it("reports a merchant that cannot be reached instead of running empty", async () => {
    const schema = parseMerchantSchema(BASE); // no catalogue block
    const adapter = new MerchantAdapter(schema, cannedTransport());
    const env = createEnvironment({
      catalog: (state) => new AdapterCatalogSource(adapter, state),
    });
    await expect(prepareEnvironment(env)).rejects.toThrow(/enumerate its catalogue/);
  });
});

describe("the in-process merchant still answers the same interface", () => {
  it("lists what it holds", async () => {
    const env = createEnvironment({});
    const source = new LocalCatalogSource(env.state);
    const ids = await source.listIds();
    expect(ids).toContain("p-coffee-arabica");
  });

  it("primes to nothing, because it seeds itself", async () => {
    const env = createEnvironment({});
    const source = new LocalCatalogSource(env.state);
    await source.prime([]);
    expect(env.state.getProduct("p-coffee-arabica")).toBeDefined();
  });
});
