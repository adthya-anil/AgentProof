/**
 * Nordwell Provisions — the second merchant.
 *
 * The adapter's whole claim is that the twelve invariants no longer depend on
 * HamperHub's shape. That claim was, until this file, a design property with a test
 * double behind it. A double proves the mapping code reads fields; it cannot prove the
 * engine works against a merchant that was not designed with it in mind, because the
 * double was written by the same person, at the same time, from the same assumptions.
 *
 * So Nordwell is a real GraphQL service with its own data model, served from this app
 * and reached over HTTP by the same adapter a third party would use. It disagrees with
 * HamperHub about nearly everything a mapping has to cope with:
 *
 *   ids            `NW-1001`, not `p-coffee-arabica`
 *   money          `{ amount: "24.50", currencyCode: "INR" }` — decimal strings
 *   nesting        price under `pricing.unit`, stock under `availability.quantity`
 *   naming         `title` not `name`, `dietary.contains` not `allergens`
 *   allergens      a comma-delimited string, absent entirely when not tracked
 *   vegan          `dietary.tags` containing `PLANT_BASED`, not a boolean
 *   versions       none at all — no price version, no inventory revision
 *   reservations   no such concept; the catalogue is read-only
 *
 * The last two matter most, because they are the ones that decide what can be checked.
 * Nordwell cannot support the inventory rule as written — it has no reservations — so
 * that rule is withheld by name rather than run against a reservation id it has never
 * heard of. Price binding, on the other hand, does work, because the engine versions the
 * price by observation rather than needing the merchant to.
 */

export interface NordwellProduct {
  id: string;
  title: string;
  collection: string;
  pricing: { unit: { amount: string; currencyCode: string }; floor: { amount: string } };
  availability: { quantity: number };
  dietary: { contains?: string; tags: string[] };
  giftable: boolean;
}

/**
 * A catalogue that overlaps HamperHub's in kind but not in identity.
 *
 * Deliberately not a renamed copy. Different products, different prices, and — the part
 * that earns its keep — one entry with allergen data genuinely missing rather than
 * empty, because that is the distinction the whole `whenMissing` mechanism exists to
 * preserve and it needs to exist in a merchant that was not built to demonstrate it.
 */
export const NORDWELL_CATALOG: readonly NordwellProduct[] = Object.freeze([
  {
    id: "NW-1001",
    title: "Nordic Roast Filter Coffee 250g",
    collection: "Beverages / Coffee",
    pricing: { unit: { amount: "649.00", currencyCode: "INR" }, floor: { amount: "580.00" } },
    availability: { quantity: 12 },
    dietary: { contains: "", tags: ["PLANT_BASED"] },
    giftable: true,
  },
  {
    id: "NW-1002",
    title: "Single Estate Assam Tea 200g",
    collection: "Beverages / Tea",
    pricing: { unit: { amount: "429.50", currencyCode: "INR" }, floor: { amount: "400.00" } },
    availability: { quantity: 30 },
    dietary: { contains: "", tags: ["PLANT_BASED"] },
    giftable: true,
  },
  {
    id: "NW-1003",
    title: "Sea Salt Caramel Chocolate Bar",
    collection: "Confectionery",
    pricing: { unit: { amount: "289.00", currencyCode: "INR" }, floor: { amount: "260.00" } },
    availability: { quantity: 18 },
    dietary: { contains: "milk, soy", tags: [] },
    giftable: true,
  },
  {
    id: "NW-1004",
    /**
     * The important one. `dietary.contains` is absent, not empty — Nordwell does not
     * track allergens for this line. An integration reading that as "allergen-free" is
     * unsafe, which is the same trap HamperHub's truffle sets, arrived at independently
     * because it is what actually happens in catalogues.
     */
    title: "Artisan Hazelnut Praline Selection",
    collection: "Confectionery",
    pricing: { unit: { amount: "749.00", currencyCode: "INR" }, floor: { amount: "700.00" } },
    availability: { quantity: 6 },
    dietary: { tags: [] },
    giftable: true,
  },
  {
    id: "NW-1005",
    title: "Stoneware Pour-Over Mug",
    collection: "Homeware",
    pricing: { unit: { amount: "515.00", currencyCode: "INR" }, floor: { amount: "480.00" } },
    availability: { quantity: 3 },
    dietary: { tags: [] },
    giftable: true,
  },
  {
    id: "NW-1006",
    title: "Kraft Gift Box with Ribbon",
    collection: "Packaging",
    pricing: { unit: { amount: "150.00", currencyCode: "INR" }, floor: { amount: "140.00" } },
    availability: { quantity: 50 },
    dietary: { tags: [] },
    giftable: false,
  },
]);

/**
 * Mutable live prices and stock, so a run can move them mid-journey.
 *
 * Held apart from the frozen seed so a demo can re-price without editing the catalogue,
 * which is how the price-binding rule gets something real to detect.
 */
const overrides = new Map<string, { amount?: string; quantity?: number }>();

export function setNordwellPrice(id: string, majorAmount: string): void {
  overrides.set(id, { ...overrides.get(id), amount: majorAmount });
}

export function setNordwellStock(id: string, quantity: number): void {
  overrides.set(id, { ...overrides.get(id), quantity });
}

export function resetNordwell(): void {
  overrides.clear();
}

/** The catalogue as Nordwell would answer it right now. */
export function nordwellProducts(ids?: readonly string[]): NordwellProduct[] {
  const wanted = ids ? new Set(ids) : null;
  return NORDWELL_CATALOG.filter((p) => !wanted || wanted.has(p.id)).map((p) => {
    const override = overrides.get(p.id);
    if (!override) return p;
    return {
      ...p,
      pricing: {
        ...p.pricing,
        unit: { ...p.pricing.unit, amount: override.amount ?? p.pricing.unit.amount },
      },
      availability: {
        quantity: override.quantity ?? p.availability.quantity,
      },
    };
  });
}

/**
 * The mapping that lets the engine read Nordwell.
 *
 * Every value here is a claim about Nordwell's API, and each optional field left out is
 * a capability the engine will not pretend to have. `supportsReservations` is absent,
 * so the inventory rule is withheld; `derive.priceVersion` is `observed`, so price
 * binding runs on the engine's own bookkeeping.
 */
export const NORDWELL_MAPPING = {
  merchant: "nordwell",
  label: "Nordwell Provisions",
  currency: "INR",
  defaultCategory: "snack" as const,
  transport: {
    kind: "graphql",
    endpoint: "http://127.0.0.1:3000/api/merchant/nordwell",
    query: `query Catalogue($ids: [ID!]!) {
  products(ids: $ids) {
    id
    title
    collection
    pricing { unit { amount currencyCode } floor { amount } }
    availability { quantity }
    dietary { contains tags }
    giftable
  }
}`,
    root: "products",
  },
  product: {
    id: "id",
    name: "title",
    price: { path: "pricing.unit.amount", unit: "decimalString" },
    minPrice: { path: "pricing.floor.amount", unit: "decimalString" },
    // Absent for NW-1004, and `unknown` keeps that absence intact rather than reading
    // it as "no allergens".
    allergens: { path: "dietary.contains", whenMissing: "unknown", splitOn: "," },
    // Not a boolean: a tag list that may contain PLANT_BASED.
    vegan: { path: "dietary.tags", whenMissing: "unknown", truthy: ["PLANT_BASED"] },
    bundleEligible: { path: "giftable", whenMissing: "false" },
    category: {
      path: "collection",
      map: {
        "Beverages / Coffee": "coffee",
        "Beverages / Tea": "tea",
        Confectionery: "chocolate",
        Homeware: "mug",
        Packaging: "packaging",
      },
      fallback: "snack",
    },
  },
  inventory: { available: "availability.quantity" },
  /**
   * How an agent browses Nordwell.
   *
   * A listing operation rather than a fixed id list, because that is what a real
   * storefront offers and because a hard-coded set would quietly decide what is under
   * test. `products` with no ids returns the whole catalogue.
   */
  catalogue: {
    listQuery: `query All {
  products {
    id
    title
    collection
    pricing { unit { amount currencyCode } floor { amount } }
    availability { quantity }
    dietary { contains tags }
    giftable
  }
}`,
    root: "products",
  },
  // No version fields exist, so the engine keeps its own counters by observation.
  derive: { priceVersion: "observed", inventoryVersion: "observed" },
  // Nordwell has no reservation concept. Claiming otherwise would leave the inventory
  // rule comparing a hold that cannot exist.
  supportsReservations: false,
} as const;
