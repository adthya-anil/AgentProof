import { z } from "zod";
import type { Minor } from "../core/money.js";

/**
 * A declarative description of someone else's catalogue.
 *
 * The twelve invariants are written against the spec's entity model — `priceMinor`,
 * `priceVersion`, `allergens`, an inventory record with a `version`. No merchant's API
 * looks like that. Shopify calls it `variants[0].price` as a decimal string, a bespoke
 * REST service calls it `price_cents`, a GraphQL storefront nests it under
 * `priceRange.minVariantPrice.amount`. The rules are right and the shapes are all
 * different, so something has to translate.
 *
 * The alternative is a TypeScript adapter class per merchant, which is where this would
 * naturally end up. Rejected: an adapter is code, code needs review, review needs a
 * reviewer who knows both the merchant's API and this engine's assumptions, and the
 * failure mode is a silent mis-mapping that makes every subsequent report wrong. A
 * declarative mapping can be validated, diffed, and — the part that matters — used to
 * work out what the merchant cannot answer.
 *
 * That last point is the reason this is a data structure rather than an interface.
 * Capabilities are *derived* from which optional paths a mapping fills in, so a merchant
 * cannot claim `product.priceVersion` without saying where it comes from. The
 * declaration and the capability are the same fact, and cannot drift apart.
 */

/**
 * Where a value lives in a response.
 *
 * Dots and bracket indices only — `variants[0].price`, `stock.count`. Not JSONPath:
 * filters and wildcards would let a mapping express "the cheapest variant", which
 * sounds useful until a price moves and the mapping silently starts reading a different
 * variant than the one that was quoted. Ambiguity about which number is the price is
 * not a feature.
 */
const fieldPath = z
  .string()
  .min(1)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*(\[\d+\]|\.[A-Za-z_][A-Za-z0-9_]*)*$/,
    "must be a dotted path such as stock.count or variants[0].price",
  );

/**
 * Money, with its unit stated rather than inferred.
 *
 * `unit` is required and has no default. A merchant returning `1299` might mean
 * ₹1,299.00 or ₹12.99, and there is no way to tell from the value — both are plausible
 * for a coffee hamper. Guessing wrong is a hundredfold error in the one quantity this
 * entire product exists to protect, so the mapping must say. `decimalString` exists
 * because Shopify and most GraphQL storefronts return `"12.99"`, and parsing that as a
 * float and multiplying by 100 gives 1298.9999999999998.
 */
const moneyField = z.object({
  path: fieldPath,
  unit: z.enum(["minor", "major", "decimalString"]),
});

export type MoneyField = z.infer<typeof moneyField>;

/**
 * A boolean that may be genuinely unknown.
 *
 * `whenMissing` is required because the safety rule depends on the difference. An
 * allergen list that is absent because the merchant does not track allergens is not the
 * same as one absent because this product has none, and treating the first as the second
 * is how an allergic buyer gets sold a peanut. `unknown` maps to `null`, which the
 * existing tri-state logic already refuses to treat as safe.
 */
const triStateField = z.object({
  path: fieldPath,
  whenMissing: z.enum(["false", "true", "unknown"]),
  /** Values that count as true, for APIs that answer "Y", "yes" or 1. */
  truthy: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
});

const listField = z.object({
  path: fieldPath,
  whenMissing: z.enum(["empty", "unknown"]),
  /**
   * Splits a delimited string into a list.
   *
   * For the common case of `"milk, nuts"` in one field. Deliberately not a free-text
   * parser: if a merchant keeps allergens in prose, the honest answer is to leave this
   * unmapped and let the safety rule be withheld, rather than to guess with a regex and
   * report coverage that rests on it.
   */
  splitOn: z.string().min(1).optional(),
});

/** The entity model's closed category union, as a runtime schema. */
const productCategory = z.enum([
  "coffee",
  "tea",
  "chocolate",
  "candle",
  "mug",
  "card",
  "snack",
  "packaging",
]);

export const productMapping = z.object({
  id: fieldPath,
  name: fieldPath,
  price: moneyField,
  /** Optional. Absent means `product.priceVersion` is not natively available. */
  priceVersion: fieldPath.optional(),
  /** Optional. Absent means the merchant does not declare allergens at all. */
  allergens: listField.optional(),
  /** Optional. Absent means the merchant does not declare vegan status. */
  vegan: triStateField.optional(),
  /**
   * Category, translated explicitly.
   *
   * The entity model's categories are a closed union and a foreign merchant's are not,
   * so there is no safe automatic mapping — "Gifting > Beverages" is not a member of
   * anything here. `map` is therefore a stated translation and `fallback` is stated
   * too, rather than a value this code picks. No invariant reads category, so the cost
   * of getting it wrong is a mis-filtered product search rather than a wrong verdict;
   * that is a reason to keep it simple, not a reason to guess.
   */
  category: z
    .object({
      path: fieldPath,
      map: z.record(productCategory),
      fallback: productCategory,
    })
    .optional(),
  bundleEligible: triStateField.optional(),
  /** The floor the merchant will not sell below. Falls back to the list price. */
  minPrice: moneyField.optional(),
});

export const inventoryMapping = z.object({
  /**
   * Free stock as a count.
   *
   * Optional as a whole, because plenty of storefronts expose only `inStock: true`. A
   * boolean cannot answer "are there four left", and mapping it to `1` would turn
   * "some available" into "exactly enough for this order" — a guess that reads as a
   * measurement.
   */
  available: fieldPath.optional(),
  version: fieldPath.optional(),
});

/**
 * Let this engine version what the merchant does not.
 *
 * The two version rules test equality, never ordering, and the engine already re-reads
 * the catalogue at every checkpoint. So it can keep the counter itself: remember the
 * price it last saw, and bump a version when the merchant answers with a different one.
 * No cooperation from the merchant is required beyond exposing a price.
 *
 * This turns "price binding cannot be checked against this merchant" into "it can",
 * which is the difference between a portable engine and a HamperHub accessory. It is
 * also strictly better than the content hash this started as: a monotonic counter makes
 * ₹599 → ₹649 → ₹599 version 3, so a price that moved and moved back is still visible
 * as having moved, which a hash of the price cannot express.
 *
 * The limitation that remains, stated because it is otherwise invisible: the engine only
 * sees changes between its own reads. A price that moves and returns *between two
 * checkpoints* is not observed at all. A merchant-supplied monotonic version would catch
 * that, so `observed` and native are not equivalent and are reported apart.
 */
export const derivedVersions = z.object({
  priceVersion: z.literal("observed").optional(),
  inventoryVersion: z.literal("observed").optional(),
});

const restTransport = z.object({
  kind: z.literal("rest"),
  baseUrl: z.string().url(),
  /** `{id}` is substituted. A single-product read. */
  productPath: z.string().min(1),
  method: z.enum(["GET", "POST"]).default("GET"),
  headers: z.record(z.string()).default({}),
  /**
   * Where the product object sits inside the response body.
   *
   * Omitted means the body *is* the product. `data.product` for the common envelope.
   */
  root: fieldPath.optional(),
  /**
   * A batch endpoint, when the merchant has one.
   *
   * Strongly preferred and the reason this is not an afterthought: a quote with six
   * line items evaluated at five checkpoints is thirty single-product reads, and doing
   * that sequentially inside rule evaluation is how a preflight suite starts taking
   * minutes. When absent, the adapter fetches ids concurrently instead.
   */
  batch: z
    .object({
      path: z.string().min(1),
      /** Query parameter carrying the comma-separated ids. */
      idsParam: z.string().min(1),
      /** Where the array of products sits in the response. */
      root: fieldPath,
    })
    .optional(),
});

const graphqlTransport = z.object({
  kind: z.literal("graphql"),
  endpoint: z.string().url(),
  headers: z.record(z.string()).default({}),
  /** Must accept `$ids: [ID!]!` and return a list. One round trip per checkpoint. */
  query: z.string().min(1),
  /** Where the array of products sits inside `data`. */
  root: fieldPath,
});

/**
 * How to find out what the merchant sells.
 *
 * Fetch-by-id is enough to *verify* a quote, and it was all the adapter needed while a
 * mapping only fed the invariants. It is not enough to *test* a merchant: an autonomous
 * buyer starts by searching, and `search_products` cannot answer from a catalogue that
 * can only be addressed by ids nobody has yet. Without this block, a mapped merchant can
 * be checked but not shopped — which makes the mapping worth much less than the point of
 * having one.
 *
 * Three ways, because merchants differ and none of them is guessable:
 *
 *  - `ids` — an explicit set. Honest and blunt: these are the products under test. Right
 *    for a fixed catalogue, and the only option when a merchant offers no listing at all.
 *  - `listQuery` — a GraphQL operation returning every product.
 *  - `listPath` — a REST endpoint returning a list.
 *
 * Deliberately no pagination. A partial page silently becomes "the catalogue", and a
 * preflight run over an unknown fraction of a shop reports a coverage number that means
 * nothing. Better to state the ids than to sample without saying so.
 */
const catalogueSource = z.object({
  ids: z.array(z.string().min(1)).optional(),
  listQuery: z.string().min(1).optional(),
  listPath: z.string().min(1).optional(),
  /** Where the array of products sits in the listing response. */
  root: fieldPath.optional(),
});

/**
 * How to move this merchant's own prices and stock, when it lets you.
 *
 * Needed because a state perturbation cannot be applied locally against a mapped
 * merchant. `syncFromMerchant` treats the merchant as the source of truth — correctly —
 * so it overwrites any local edit at the next checkpoint, including one a perturbation
 * deliberately injected. Measured: a local setPrice to ₹700.92 was reverted to ₹649.00 on
 * the following read, leaving the invariant comparing version 3 against version 1 with
 * identical prices and ₹0.00 at risk. The rule fired on churn the harness caused itself.
 *
 * So the change has to happen at the merchant. Optional, and honestly so: a real
 * third-party catalogue will not expose an admin API, and a scenario that cannot inject
 * its fault must report that it did not run rather than appear to have passed.
 *
 * `{id}` and `{value}` are substituted into the variables.
 */
const adminSurface = z.object({
  setPrice: z
    .object({
      /** A mutation taking $id and $amount, where $amount is a major-unit string. */
      mutation: z.string().min(1),
    })
    .optional(),
  setStock: z
    .object({
      /** A mutation taking $id and $quantity as an integer count. */
      mutation: z.string().min(1),
    })
    .optional(),
});

export const merchantSchema = z.object({
  merchant: z.string().min(1),
  /** Free-text, shown in reports so a reader knows which integration produced them. */
  label: z.string().min(1),
  currency: z.literal("INR"),
  transport: z.discriminatedUnion("kind", [restTransport, graphqlTransport]),
  product: productMapping,
  /** Used for every product when no category mapping is given. Stated, not guessed. */
  defaultCategory: productCategory,
  inventory: inventoryMapping.default({}),
  derive: derivedVersions.default({}),
  /**
   * Whether the merchant can hold stock against a reservation id.
   *
   * Defaults to false. Most catalogue APIs are read-only and have no such concept, and
   * claiming it by default would leave the inventory rule comparing a reservation that
   * never existed.
   */
  supportsReservations: z.boolean().default(false),
  /**
   * How to enumerate the catalogue, for runs that shop rather than only verify.
   *
   * Optional, because a mapping that only feeds the invariants does not need it. A run
   * that puts an agent in front of the merchant does, and says so plainly when it is
   * absent rather than presenting an empty shop as a finished test.
   */
  catalogue: catalogueSource.default({}),
  /**
   * Admin mutations, for runs that need to change the merchant under the buyer.
   *
   * Absent means state perturbations cannot run against this merchant, and the journeys
   * that depend on them are reported as not exercised.
   */
  admin: adminSurface.default({}),
});

export type MerchantSchema = z.infer<typeof merchantSchema>;
export type ProductMapping = z.infer<typeof productMapping>;

/** Parses and validates a mapping, throwing with the field path on failure. */
export function parseMerchantSchema(input: unknown): MerchantSchema {
  return merchantSchema.parse(input);
}

// -- reading values out of a response ---------------------------------------

/**
 * Resolves a dotted path, returning undefined rather than throwing.
 *
 * Undefined is a legitimate answer that the capability layer acts on, so a missing
 * field must not become an exception at this depth — the caller decides whether an
 * absence is expected or a mapping error.
 */
export function readPath(source: unknown, path: string): unknown {
  let current = source;
  for (const segment of path.split(".")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)((\[\d+\])*)$/.exec(segment);
    if (!match) return undefined;
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[match[1] as string];
    for (const index of match[2]?.match(/\d+/g) ?? []) {
      if (!Array.isArray(current)) return undefined;
      current = current[Number(index)];
    }
  }
  return current;
}

export class MappingError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} (at '${path}')`);
    this.name = "MappingError";
  }
}

/**
 * Converts a mapped value to minor units.
 *
 * Throws rather than defaulting. A price that cannot be read is not zero, and a zero
 * would flow into a quote, pass the floor-price rule for the wrong reason, and let an
 * agent buy a hamper for nothing. An exception stops the journey and names the path.
 */
export function readMoney(source: unknown, field: MoneyField): Minor {
  const raw = readPath(source, field.path);
  if (raw === undefined || raw === null) {
    throw new MappingError("no value for a required money field", field.path);
  }

  if (field.unit === "decimalString") {
    if (typeof raw !== "string" && typeof raw !== "number") {
      throw new MappingError(
        `expected a decimal string, got ${typeof raw}`,
        field.path,
      );
    }
    const text = String(raw).trim();
    if (!/^-?\d+(\.\d+)?$/.test(text)) {
      throw new MappingError(`not a decimal number: '${text}'`, field.path);
    }
    // Split on the point and pad, rather than parseFloat and multiply. "12.99" times
    // 100 is 1298.9999999999998 in binary floating point, and Math.round would hide
    // that here while a different value elsewhere rounded the wrong way.
    const [whole = "0", fraction = ""] = text.replace("-", "").split(".");
    const paise = `${fraction}00`.slice(0, 2);
    const magnitude = Number(whole) * 100 + Number(paise);
    return text.startsWith("-") ? -magnitude : magnitude;
  }

  const numeric = typeof raw === "string" ? Number(raw) : raw;
  if (typeof numeric !== "number" || !Number.isFinite(numeric)) {
    throw new MappingError(`not a finite number: '${String(raw)}'`, field.path);
  }
  if (field.unit === "major") {
    const minor = numeric * 100;
    if (!Number.isInteger(minor)) {
      throw new MappingError(
        `major-unit value ${numeric} is not a whole number of paise`,
        field.path,
      );
    }
    return minor;
  }
  if (!Number.isInteger(numeric)) {
    throw new MappingError(
      `minor-unit value ${numeric} is not an integer`,
      field.path,
    );
  }
  return numeric;
}

const DEFAULT_TRUTHY = [true, 1, "1", "true", "TRUE", "yes", "YES", "Y", "y"];

/** Reads a tri-state boolean. `null` means genuinely unknown. */
export function readTriState(
  source: unknown,
  field: z.infer<typeof triStateField>,
): boolean | null {
  const raw = readPath(source, field.path);
  if (raw === undefined || raw === null) {
    return field.whenMissing === "unknown" ? null : field.whenMissing === "true";
  }
  if (typeof raw === "boolean") return raw;
  const truthy = field.truthy ?? DEFAULT_TRUTHY;

  /**
   * A tag list means "contains", not "equals".
   *
   * How most storefronts express a flag: `tags: ["PLANT_BASED", "GIFT"]` rather than
   * `vegan: true`. Comparing the whole array against the truthy list never matches, so
   * before this every tagged product read as false — and a vegan product marked
   * not-vegan makes INV-PRODUCT-SAFETY reject a correct integration, which is a false
   * violation rather than a missed one. Found by running against a real merchant; no
   * unit test had a tag list in it, because the fixtures were written from the same
   * assumption as the code.
   */
  if (Array.isArray(raw)) {
    return raw.some((entry) =>
      truthy.some((candidate) => candidate === entry),
    );
  }

  return truthy.some((candidate) => candidate === raw);
}

/** Reads a string list. `null` means the merchant does not know. */
export function readList(
  source: unknown,
  field: z.infer<typeof listField>,
): string[] | null {
  const raw = readPath(source, field.path);
  if (raw === undefined || raw === null) {
    return field.whenMissing === "unknown" ? null : [];
  }
  if (Array.isArray(raw)) {
    return raw.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    const text = raw.trim();
    if (text === "") return [];
    return field.splitOn
      ? text
          .split(field.splitOn)
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [text];
  }
  return [String(raw)];
}

/**
 * A stable 32-bit version number derived from content.
 *
 * `Product.priceVersion` is typed `number`, so a hex digest will not do. Signed-safe and
 * always positive, because a negative version would read as a sentinel.
 */
export function derivedVersion(...parts: Array<string | number>): number {
  const text = parts.join("|");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 1;
}
