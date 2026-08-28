import { describe, expect, it } from "vitest";
import { MerchantAdapter, type CatalogTransport } from "../src/lib/merchant/adapter.js";
import { MappingError, parseMerchantSchema } from "../src/lib/merchant/mapping.js";
import {
  GraphQLTransport,
  RestTransport,
  TransportError,
  type Fetcher,
} from "../src/lib/merchant/transport.js";

/**
 * The adapter, and the thing that makes it more than a field renamer: it works out what
 * the merchant cannot answer, so the engine can withhold those rules instead of running
 * them against undefined.
 */

const BASE = {
  merchant: "acme",
  label: "Acme",
  currency: "INR" as const,
  defaultCategory: "coffee" as const,
  transport: {
    kind: "rest" as const,
    baseUrl: "https://api.acme.test",
    productPath: "/products/{id}",
  },
  product: {
    id: "id",
    name: "title",
    price: { path: "price_cents", unit: "minor" as const },
  },
};

/** A transport that returns canned rows, so no network and no mock server. */
function canned(rows: Record<string, unknown>): CatalogTransport {
  return {
    kind: "canned",
    async fetch(ids) {
      const out = new Map<string, unknown>();
      for (const id of ids) if (id in rows) out.set(id, rows[id]);
      return out;
    },
  };
}

function adapterFor(
  overrides: Record<string, unknown>,
  rows: Record<string, unknown> = {},
): MerchantAdapter {
  const schema = parseMerchantSchema({ ...BASE, ...overrides });
  return new MerchantAdapter(schema, canned(rows));
}

describe("capabilities are derived from the mapping, not declared beside it", () => {
  it("claims only lookup and content hash for a bare price list", () => {
    const capabilities = adapterFor({}).capabilities();
    expect(capabilities.declared).toEqual(["product.lookup", "approval.contentHash"]);
  });

  it("cannot claim a price version without saying where it comes from", () => {
    /**
     * The point of deriving rather than declaring. A hand-written `capabilities: [...]`
     * list could claim `product.priceVersion` while no field supplied it, and every
     * price-binding check would then run against undefined and pass.
     */
    expect(adapterFor({}).capabilities().has("product.priceVersion")).toBe(false);
    expect(
      adapterFor({ product: { ...BASE.product, priceVersion: "updated_at" } })
        .capabilities()
        .has("product.priceVersion"),
    ).toBe(true);
  });

  it("counts a derived version as the capability being present", () => {
    const adapter = adapterFor({ derive: { priceVersion: "observed" } });
    expect(adapter.capabilities().has("product.priceVersion")).toBe(true);
    // But says it is synthesised, so no report implies a merchant guarantee.
    expect(adapter.derivedCapabilities()).toEqual(["product.priceVersion"]);
  });

  it("reports a native version as not derived", () => {
    const adapter = adapterFor({
      product: { ...BASE.product, priceVersion: "revision" },
    });
    expect(adapter.derivedCapabilities()).toEqual([]);
  });

  it("will not derive an inventory version with no stock count to hash", () => {
    // Deriving from a field that is not mapped would be hashing undefined — a stable
    // version that never changes, i.e. a rule that can never fire.
    const adapter = adapterFor({ derive: { inventoryVersion: "observed" } });
    expect(adapter.capabilities().has("inventory.version")).toBe(false);
  });

  it("derives an inventory version once a stock count exists", () => {
    const adapter = adapterFor({
      inventory: { available: "stock.count" },
      derive: { inventoryVersion: "observed" },
    });
    expect(adapter.capabilities().has("inventory.available")).toBe(true);
    expect(adapter.capabilities().has("inventory.version")).toBe(true);
    expect(adapter.derivedCapabilities()).toEqual(["inventory.version"]);
  });

  it("does not claim reservations by default", () => {
    // Most catalogue APIs are read-only. Claiming it would leave the inventory rule
    // comparing a reservation that never existed.
    expect(adapterFor({}).capabilities().has("reservation.lookup")).toBe(false);
    expect(
      adapterFor({ supportsReservations: true }).capabilities().has("reservation.lookup"),
    ).toBe(true);
  });

  it("claims allergens and vegan only when mapped", () => {
    expect(adapterFor({}).capabilities().has("product.allergens")).toBe(false);
    const mapped = adapterFor({
      product: {
        ...BASE.product,
        allergens: { path: "allergens", whenMissing: "unknown" },
        vegan: { path: "is_vegan", whenMissing: "unknown" },
      },
    });
    expect(mapped.capabilities().has("product.allergens")).toBe(true);
    expect(mapped.capabilities().has("product.vegan")).toBe(true);
  });
});

describe("translating a product", () => {
  it("maps the fields the entity model needs", async () => {
    const adapter = adapterFor(
      {
        product: {
          ...BASE.product,
          allergens: { path: "allergens", whenMissing: "unknown", splitOn: "," },
          vegan: { path: "is_vegan", whenMissing: "unknown" },
        },
        inventory: { available: "stock.count", version: "stock.revision" },
      },
      {
        "p-1": {
          id: "p-1",
          title: "Arabica 250g",
          price_cents: 59900,
          allergens: "milk, soy",
          is_vegan: false,
          stock: { count: 7, revision: 3 },
        },
      },
    );

    const snapshot = await adapter.snapshot(["p-1"]);
    const product = snapshot.getProduct("p-1");

    expect(product?.name).toBe("Arabica 250g");
    expect(product?.priceMinor).toBe(59900);
    expect(product?.allergens).toEqual(["milk", "soy"]);
    expect(product?.vegan).toBe(false);
    expect(snapshot.getInventory("p-1")?.available).toBe(7);
    expect(snapshot.getInventory("p-1")?.version).toBe(3);
    expect(snapshot.freeStock("p-1")).toBe(7);
  });

  it("treats the list price as the floor when none is declared", async () => {
    /**
     * The strict reading. Assuming a merchant will discount below a price it never
     * published would invent permission it did not grant, and the floor-price rule
     * would then allow exactly that.
     */
    const adapter = adapterFor({}, { "p-1": { id: "p-1", title: "X", price_cents: 1000 } });
    const snapshot = await adapter.snapshot(["p-1"]);
    expect(snapshot.getProduct("p-1")?.minPriceMinor).toBe(1000);
  });

  it("changes the derived price version when the price moves", async () => {
    const rows = { "p-1": { id: "p-1", title: "X", price_cents: 59900 } };
    const cheap = await adapterFor({ derive: { priceVersion: "observed" } }, rows)
      .snapshot(["p-1"]);

    const dearer = await adapterFor(
      { derive: { priceVersion: "observed" } },
      { "p-1": { id: "p-1", title: "X", price_cents: 64900 } },
    ).snapshot(["p-1"]);

    // This is what restores INV-PRICE-BINDING for a merchant with no version field.
    expect(cheap.getProduct("p-1")?.priceVersion).not.toBe(
      dearer.getProduct("p-1")?.priceVersion,
    );
  });

  it("does not double-count reservations held elsewhere", async () => {
    /**
     * A remote catalogue reports what is free, not what this engine is holding.
     * Subtracting local reservations from a number that already excludes them would
     * show stock as unavailable twice and reject orders that could be filled.
     */
    const adapter = adapterFor(
      { inventory: { available: "stock.count" } },
      { "p-1": { id: "p-1", title: "X", price_cents: 100, stock: { count: 5 } } },
    );
    const snapshot = await adapter.snapshot(["p-1"]);
    expect(snapshot.getInventory("p-1")?.reserved).toBe(0);
    expect(snapshot.freeStock("p-1")).toBe(5);
  });

  it("refuses a boolean where a stock count is required", async () => {
    /**
     * Mapping `inStock: true` to 1 would turn "some available" into "exactly enough for
     * this order". The error says to leave the field unmapped, which withholds the
     * inventory rule — an honest gap instead of a fabricated count.
     */
    const adapter = adapterFor(
      { inventory: { available: "in_stock" } },
      { "p-1": { id: "p-1", title: "X", price_cents: 100, in_stock: true } },
    );
    await expect(adapter.snapshot(["p-1"])).rejects.toThrow(
      /A boolean cannot answer how many remain/,
    );
  });

  it("refuses a product with no name", async () => {
    // Every violation message identifies the item; "undefined: 2 requested but only 1
    // available" is not a usable finding.
    const adapter = adapterFor({}, { "p-1": { id: "p-1", price_cents: 100 } });
    await expect(adapter.snapshot(["p-1"])).rejects.toThrow(MappingError);
  });

  it("omits a product the merchant does not have, rather than inventing one", async () => {
    // The invariants already treat an unresolvable product as their own finding
    // ("no longer in the catalog"). A placeholder here would mask that verdict.
    const adapter = adapterFor({}, { "p-1": { id: "p-1", title: "X", price_cents: 100 } });
    const snapshot = await adapter.snapshot(["p-1", "p-missing"]);
    expect(snapshot.getProduct("p-missing")).toBeUndefined();
    expect(snapshot.resolvedIds).toEqual(["p-1"]);
  });

  it("translates categories only as instructed", async () => {
    const adapter = adapterFor(
      {
        product: {
          ...BASE.product,
          category: {
            path: "collection",
            map: { "Gifting > Beverages": "coffee" },
            fallback: "packaging",
          },
        },
      },
      {
        "p-1": { id: "p-1", title: "X", price_cents: 1, collection: "Gifting > Beverages" },
        "p-2": { id: "p-2", title: "Y", price_cents: 1, collection: "Something Else" },
      },
    );
    const snapshot = await adapter.snapshot(["p-1", "p-2"]);
    expect(snapshot.getProduct("p-1")?.category).toBe("coffee");
    expect(snapshot.getProduct("p-2")?.category).toBe("packaging");
  });

  it("makes no request at all for an empty id list", async () => {
    let called = false;
    const adapter = new MerchantAdapter(parseMerchantSchema(BASE), {
      kind: "spy",
      async fetch() {
        called = true;
        return new Map();
      },
    });
    await adapter.snapshot([]);
    expect(called).toBe(false);
  });

  it("de-duplicates ids before fetching", async () => {
    // A bundle with the same product on two lines must not be two reads.
    const seen: string[][] = [];
    const adapter = new MerchantAdapter(parseMerchantSchema(BASE), {
      kind: "spy",
      async fetch(ids) {
        seen.push([...ids]);
        return new Map();
      },
    });
    await adapter.snapshot(["p-1", "p-1", "p-2"]);
    expect(seen).toEqual([["p-1", "p-2"]]);
  });
});

describe("REST transport", () => {
  function fetcherFor(
    handler: (url: string) => { status?: number; body: unknown },
  ): { fetcher: Fetcher; urls: string[] } {
    const urls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      urls.push(url);
      const { status = 200, body } = handler(url);
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      };
    };
    return { fetcher, urls };
  }

  it("substitutes the id into the path", async () => {
    const { fetcher, urls } = fetcherFor(() => ({
      body: { id: "p-1", title: "X", price_cents: 1 },
    }));
    const transport = new RestTransport(
      parseMerchantSchema(BASE).transport as never,
      "id",
      fetcher,
    );
    await transport.fetch(["p-1"]);
    expect(urls[0]).toBe("https://api.acme.test/products/p-1");
  });

  it("unwraps an envelope when a root is given", async () => {
    const schema = parseMerchantSchema({
      ...BASE,
      transport: { ...BASE.transport, root: "data" },
    });
    const { fetcher } = fetcherFor(() => ({
      body: { data: { id: "p-1", title: "X", price_cents: 42 } },
    }));
    const transport = new RestTransport(schema.transport as never, "id", fetcher);
    const rows = await transport.fetch(["p-1"]);
    expect(rows.get("p-1")).toEqual({ id: "p-1", title: "X", price_cents: 42 });
  });

  it("treats a 404 as a missing product, not a failure", async () => {
    const { fetcher } = fetcherFor((url) =>
      url.endsWith("p-gone") ? { status: 404, body: {} } : { body: { id: "p-1" } },
    );
    const transport = new RestTransport(
      parseMerchantSchema(BASE).transport as never,
      "id",
      fetcher,
    );
    const rows = await transport.fetch(["p-1", "p-gone"]);
    expect(rows.has("p-1")).toBe(true);
    expect(rows.has("p-gone")).toBe(false);
  });

  it("raises other HTTP failures with the status", async () => {
    // A 500 is not "no such product" and must not be silently mapped to one.
    const { fetcher } = fetcherFor(() => ({ status: 503, body: {} }));
    const transport = new RestTransport(
      parseMerchantSchema(BASE).transport as never,
      "id",
      fetcher,
    );
    await expect(transport.fetch(["p-1"])).rejects.toThrow(TransportError);
  });

  it("fetches concurrently rather than in a loop", async () => {
    /**
     * Six line items across five checkpoints is thirty reads. Sequentially that turns a
     * two-second suite into minutes, which is how a correctness feature gets removed
     * for being slow.
     */
    let inFlight = 0;
    let peak = 0;
    const fetcher: Fetcher = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { ok: true, status: 200, json: async () => ({ id: "x" }) };
    };
    const transport = new RestTransport(
      parseMerchantSchema(BASE).transport as never,
      "id",
      fetcher,
    );
    await transport.fetch(["a", "b", "c", "d"]);
    expect(peak).toBeGreaterThan(1);
  });

  it("uses one request when a batch endpoint exists", async () => {
    const schema = parseMerchantSchema({
      ...BASE,
      transport: {
        ...BASE.transport,
        batch: { path: "/products", idsParam: "ids", root: "items" },
      },
    });
    const { fetcher, urls } = fetcherFor(() => ({
      body: { items: [{ id: "a", title: "A" }, { id: "b", title: "B" }] },
    }));
    const transport = new RestTransport(schema.transport as never, "id", fetcher);
    const rows = await transport.fetch(["a", "b"]);

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("ids=a%2Cb");
    expect(rows.size).toBe(2);
  });

  it("matches batch rows by id rather than by position", async () => {
    /**
     * A batch endpoint is under no obligation to answer in the order asked, or to
     * return one row per id. Zipping by index would attribute one product's price to
     * another — a wrong price delivered with complete confidence, which is worse than
     * an error.
     */
    const schema = parseMerchantSchema({
      ...BASE,
      transport: {
        ...BASE.transport,
        batch: { path: "/products", idsParam: "ids", root: "items" },
      },
    });
    const { fetcher } = fetcherFor(() => ({
      // Reversed, and one requested id missing entirely.
      body: {
        items: [
          { id: "c", title: "C", price_cents: 300 },
          { id: "a", title: "A", price_cents: 100 },
        ],
      },
    }));
    const transport = new RestTransport(schema.transport as never, "id", fetcher);
    const rows = await transport.fetch(["a", "b", "c"]);

    expect(rows.get("a")).toMatchObject({ title: "A" });
    expect(rows.get("c")).toMatchObject({ title: "C" });
    expect(rows.has("b")).toBe(false);
  });

  it("finds the id under a merchant's own field name", async () => {
    // Assuming `id` would match nothing for a merchant using `sku`, every row would be
    // discarded, and the snapshot would look like an empty catalogue rather than a
    // misconfiguration.
    const schema = parseMerchantSchema({
      ...BASE,
      product: { ...BASE.product, id: "sku" },
      transport: {
        ...BASE.transport,
        batch: { path: "/products", idsParam: "ids", root: "items" },
      },
    });
    const { fetcher } = fetcherFor(() => ({
      body: { items: [{ sku: "a", title: "A" }] },
    }));
    const transport = new RestTransport(schema.transport as never, "sku", fetcher);
    expect((await transport.fetch(["a"])).has("a")).toBe(true);
  });
});

describe("GraphQL transport", () => {
  const GQL = {
    ...BASE,
    transport: {
      kind: "graphql" as const,
      endpoint: "https://shop.test/graphql",
      query: "query($ids:[ID!]!){ products(ids:$ids){ id title } }",
      root: "products",
    },
  };

  function gqlFetcher(body: unknown, status = 200) {
    const calls: Array<{ url: string; body: string | undefined }> = [];
    const fetcher: Fetcher = async (url, init) => {
      calls.push({ url, body: init?.body });
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      };
    };
    return { fetcher, calls };
  }

  it("sends one request with the ids as variables", async () => {
    const { fetcher, calls } = gqlFetcher({
      data: { products: [{ id: "a", title: "A" }] },
    });
    const transport = new GraphQLTransport(
      parseMerchantSchema(GQL).transport as never,
      "id",
      fetcher,
    );
    await transport.fetch(["a", "b"]);

    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]?.body ?? "{}").variables).toEqual({ ids: ["a", "b"] });
  });

  it("treats a 200 with errors as a failure", async () => {
    /**
     * The GraphQL trap. Errors arrive alongside a partial `data` with HTTP 200, so a
     * transport checking only the status would map whatever survived and report it as
     * the catalogue.
     */
    const { fetcher } = gqlFetcher({
      data: { products: null },
      errors: [{ message: "throttled" }],
    });
    const transport = new GraphQLTransport(
      parseMerchantSchema(GQL).transport as never,
      "id",
      fetcher,
    );
    await expect(transport.fetch(["a"])).rejects.toThrow(/throttled/);
  });

  it("raises when the root path holds no array", async () => {
    const { fetcher } = gqlFetcher({ data: { products: { id: "a" } } });
    const transport = new GraphQLTransport(
      parseMerchantSchema(GQL).transport as never,
      "id",
      fetcher,
    );
    await expect(transport.fetch(["a"])).rejects.toThrow(/no array at data\.products/);
  });

  it("matches rows by id, not position", async () => {
    const { fetcher } = gqlFetcher({
      data: { products: [{ id: "b", title: "B" }, { id: "a", title: "A" }] },
    });
    const transport = new GraphQLTransport(
      parseMerchantSchema(GQL).transport as never,
      "id",
      fetcher,
    );
    const rows = await transport.fetch(["a", "b"]);
    expect(rows.get("a")).toMatchObject({ title: "A" });
    expect(rows.get("b")).toMatchObject({ title: "B" });
  });
});
