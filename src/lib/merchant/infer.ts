import type { LLM } from "../agent/llm.js";
import { formatMinor } from "../core/money.js";
import type { Product } from "../core/types.js";
import { MerchantAdapter, type CatalogTransport } from "./adapter.js";
import {
  type MerchantSchema,
  merchantSchema,
  readPath,
} from "./mapping.js";

/**
 * Writing the mapping with a model, without letting the model decide anything.
 *
 * Authoring a mapping by hand is the slow part of onboarding a merchant: someone has to
 * read an unfamiliar API response and work out which field is the price. A model is very
 * good at that. It is also capable of being confidently wrong about it, and the field in
 * question is the amount of money a buyer is charged.
 *
 * So the division is strict, and it is the same one the rest of this product runs on: the
 * model explores, deterministic code decides. The model gets to *propose* a mapping. It
 * does not get to assert that the proposal is correct — that is established by building a
 * real `Product` from a real response with the proposed paths, using the same strict
 * readers the hand-written path uses. A proposal that cannot produce a valid entity is
 * rejected with the reason, never softened into a partial mapping.
 *
 * What this does not remove is the unit problem, and it is important not to pretend
 * otherwise. Nothing in the value `1299` says whether it means ₹12.99 or ₹1,299.00, and a
 * model reading one sample response cannot know either. Validation catches contradictions
 * — `unit: minor` against a value containing a decimal point — but two self-consistent
 * readings remain self-consistent. So the inferred price is always reported back as a
 * formatted amount for a human to agree with before the mapping is trusted with money.
 * That is a deliberate stopping point, not an omission.
 */

export interface InferenceInput {
  llm: LLM;
  /** Stable identifier for the merchant being mapped. */
  merchant: string;
  label: string;
  /** The transport block, supplied rather than inferred — it is configuration. */
  transport: MerchantSchema["transport"];
  /** One real response from the merchant, as parsed JSON. */
  sample: unknown;
  /** Ids that were asked for, so the id path can be checked against reality. */
  requestedIds: readonly string[];
  /**
   * The declared configuration to build on, when there is one.
   *
   * Everything a model cannot infer from a single response — how to browse the catalogue,
   * whether the merchant can be perturbed, whether it holds stock — is carried through from
   * here rather than rebuilt. Optional, so a merchant being mapped from nothing still works;
   * it simply has none of those capabilities, and says so.
   */
  base?: MerchantSchema;
}

export interface Rejection {
  ok: false;
  /** Every problem found, so one round trip fixes all of them. */
  problems: string[];
  /** The raw proposal, for a human to read when it was rejected. */
  proposal?: unknown;
}

export interface Acceptance {
  ok: true;
  schema: MerchantSchema;
  /** Built from the sample with the proposed mapping. Proof it resolves. */
  product: Product;
  /**
   * The inferred price, formatted.
   *
   * Surfaced because it is the one thing validation cannot settle. A mapping that reads
   * ₹6.49 where the merchant means ₹649.00 is internally consistent and catastrophic.
   */
  priceForReview: string;
  /** Capabilities the proposal claims, derived from it rather than asserted by it. */
  capabilities: string[];
  derivedCapabilities: string[];
  /** What the model said about its own choices, for a reviewer. */
  notes: string;
}

export type InferenceResult = Acceptance | Rejection;

const SYSTEM = `You map an unfamiliar product catalogue API onto a fixed entity model.

You are given ONE PRODUCT OBJECT, already extracted from a merchant's catalogue response.

Every path you return is relative to that single object — NOT to the response that
contained it. If the object is {"id": "X", "pricing": {"unit": {"amount": "649.00"}}},
the price path is "pricing.unit.amount", never "data.products[0].pricing.unit.amount".
The envelope has already been dealt with and is not your concern.

Use dotted paths with optional array indices, for example "pricing.unit.amount" or
"variants[0].price". Paths must address a single value. Do not use wildcards, filters or
JSONPath syntax.

Return exactly this shape:

{
  "product": {
    "id": "<path to the product's own id>",
    "name": "<path to a human-readable name>",
    "price": { "path": "<path>", "unit": "minor" | "major" | "decimalString" },
    "minPrice": { "path": "<path>", "unit": "..." },        // omit if absent
    "priceVersion": "<path>",                               // omit if absent
    "allergens": { "path": "<path>", "whenMissing": "empty" | "unknown", "splitOn": "," },
    "vegan": { "path": "<path>", "whenMissing": "false" | "true" | "unknown",
               "truthy": ["..."] },                         // truthy only for tag lists
    "bundleEligible": { "path": "<path>", "whenMissing": "false" | "true" | "unknown" }
  },
  "inventory": { "available": "<path>", "version": "<path>" },
  "defaultCategory": "coffee"|"tea"|"chocolate"|"candle"|"mug"|"card"|"snack"|"packaging",
  "notes": "<one short paragraph on the choices you made and anything ambiguous>"
}

Rules that matter more than completeness:

- OMIT a field rather than guess. An omitted field means the invariant that needs it is
  withheld and reported as not run. A wrong field means a wrong verdict about money. The
  first is an honest gap; the second is a silent failure.
- "unit" is about the *value*, not the currency. 1299 with unit "minor" means 12.99;
  1299 with "major" means 1299.00; "12.99" is "decimalString". If the sample shows a
  decimal point, it is not "minor".
- Only map "allergens" if the field genuinely lists allergens. Prose in a description is
  not an allergen list; omit it and say so in notes.
- Only map "inventory.available" if it is a COUNT. A boolean like inStock cannot answer
  "how many remain" — omit it.
- Use "whenMissing": "unknown" when the field's absence means the merchant does not track
  the fact, rather than that the fact is false.
- For a flag expressed as a tag list, map the list path and put the tag in "truthy".`;

/** Asks the model for a mapping, then refuses to believe it without proof. */
export async function inferMapping(
  input: InferenceInput,
): Promise<InferenceResult> {
  /**
   * Show the model one product, not the response that wrapped it.
   *
   * The first version handed over the whole envelope and asked for paths. The model
   * answered with `data.products[1].id` — paths rooted at the response — which is a
   * defensible reading of an ambiguous question, and every one of them was rejected by
   * validation. Removing the ambiguity is better than catching it: the envelope is
   * already handled by the transport's `root`, so it was never the model's problem to
   * solve.
   *
   * Several rows, not one. With a single row the model can only map fields that row
   * happens to carry, and an optional field absent from it is invisible — shown one
   * product with no allergen data it correctly declined to map allergens, losing a
   * capability the merchant does supply on other lines. That is the same
   * missing-versus-unknown distinction the DSL exists to preserve, one level up.
   */
  const rows = rowsFrom(input.sample);
  if (rows.length === 0) {
    return {
      ok: false,
      problems: ["no product objects found in the sample response"],
    };
  }

  const completion = await input.llm.complete({
    system: SYSTEM,
    responseFormat: "json",
    maxTokens: 1600,
    messages: [
      {
        role: "user",
        content:
          `Merchant: ${input.label}\n` +
          `Ids requested: ${input.requestedIds.join(", ")}\n\n` +
          `${rows.length === 1 ? "One product object" : `${rows.length} product objects`}` +
          ` from this merchant. A field present on any of them exists on that merchant,` +
          ` even where another omits it:\n${JSON.stringify(rows.slice(0, 6), null, 2)}`,
      },
    ],
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(completion.content));
  } catch {
    return {
      ok: false,
      problems: ["the model did not return parseable JSON"],
      proposal: completion.content,
    };
  }

  const draft = parsed as Record<string, unknown>;
  const notes = typeof draft.notes === "string" ? draft.notes : "";

  /**
   * Inference replaces the field mappings and nothing else.
   *
   * This built a whole schema from scratch, and every field it did not know about was
   * silently lost — the caller then patched selected ones back. That went wrong twice in the
   * same way: `catalogue` was dropped, noticed, and patched; then `admin` was dropped and
   * not noticed, so a merchant with working admin mutations reported "this merchant's prices
   * cannot be moved" and two perturbation journeys came back untestable. Both times the
   * missing field produced a plausible-sounding message rather than an error.
   *
   * Starting from the declared configuration and overriding only what a model can actually
   * infer removes the whole class. Where a field lives in a response is inference; which
   * endpoint to call, how to browse it, and whether it can be perturbed are configuration,
   * and a model reading one response has nothing to say about any of them.
   */
  const base = input.base;
  const candidate = {
    ...(base ?? {}),
    merchant: input.merchant,
    label: input.label,
    currency: "INR",
    transport: input.transport,
    // The inferred half.
    product: draft.product,
    inventory: draft.inventory ?? {},
    defaultCategory: draft.defaultCategory ?? base?.defaultCategory ?? "snack",
    /**
     * Versions are observed, never taken from a proposed path unless the model found a
     * real one. The engine can always track a price it can read, so preferring its own
     * counter avoids trusting a field the model believed was a version without any way
     * to check that it ever changes. Validation can prove a path resolves; it cannot
     * prove it moves.
     */
    derive: { priceVersion: "observed", inventoryVersion: "observed" },
    /**
     * Never inferred, because a read-only response cannot show whether stock can be held.
     * Taken from configuration, defaulting to false — claiming it would leave the inventory
     * rule comparing a reservation that cannot exist.
     */
    supportsReservations: base?.supportsReservations ?? false,
  };

  const schemaResult = merchantSchema.safeParse(candidate);
  if (!schemaResult.success) {
    return {
      ok: false,
      problems: schemaResult.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
      proposal: draft,
    };
  }

  const validated = await validateAgainstSample(
    schemaResult.data,
    input.sample,
    input.requestedIds,
  );
  if (!validated.ok) return { ...validated, proposal: draft };

  const adapter = new MerchantAdapter(schemaResult.data, nullTransport());
  return {
    ok: true,
    schema: schemaResult.data,
    product: validated.product,
    priceForReview: formatMinor(validated.product.priceMinor),
    capabilities: adapter.capabilities().declared,
    derivedCapabilities: adapter.derivedCapabilities(),
    notes,
  };
}

/**
 * Proves a mapping works by using it, rather than by inspecting it.
 *
 * The strongest available check, and cheap: build a real `Product` from a real response
 * through the same adapter the production path uses. Every strictness already written for
 * hand-authored mappings applies unchanged — a price that will not parse throws, a
 * missing name throws, stock that is a boolean rather than a count throws. A separate
 * validator would have been a second implementation of those rules, free to disagree with
 * the first.
 */
export async function validateAgainstSample(
  schema: MerchantSchema,
  sample: unknown,
  requestedIds: readonly string[],
): Promise<{ ok: true; product: Product } | Rejection> {
  const problems: string[] = [];

  const rows = rowsFrom(sample);
  if (rows.length === 0) {
    return { ok: false, problems: ["no product objects found in the sample response"] };
  }

  // The id path has to produce the ids that were actually asked for. A plausible-looking
  // path reading the wrong field yields a catalogue that resolves nothing, which surfaces
  // later as "the merchant has none of these products" rather than as a bad mapping.
  const idsFound = rows
    .map((row) => readPath(row, schema.product.id))
    .filter((id): id is string | number => typeof id === "string" || typeof id === "number")
    .map(String);
  if (idsFound.length === 0) {
    problems.push(
      `product.id path '${schema.product.id}' resolves to nothing in the sample`,
    );
  } else if (requestedIds.length > 0) {
    const matched = idsFound.filter((id) => requestedIds.includes(id));
    if (matched.length === 0) {
      problems.push(
        `product.id path '${schema.product.id}' gives [${idsFound
          .slice(0, 3)
          .join(", ")}], none of which match the ids requested ` +
          `[${requestedIds.join(", ")}]`,
      );
    }
  }

  /**
   * Two different existence rules, because the adapter treats these two groups
   * differently and a single rule was wrong for one of them.
   *
   * Paths the adapter cannot survive without — name, price, and any mapped stock or
   * version — must resolve on every row, because `readMoney` and the stock check throw
   * on absence. Paths that carry `whenMissing` are declared to tolerate absence: that is
   * their entire purpose, and it is how "the merchant does not track this" stays distinct
   * from "this product has none". Requiring those on every row rejected a correct
   * mapping — `dietary.contains` is genuinely absent on some Nordwell lines, which is the
   * fact the tri-state exists to carry. They must, however, appear on at least one row,
   * or the model invented a field this merchant does not have and derived a capability
   * from it.
   */
  for (const [label, path] of requiredPaths(schema)) {
    const missingOn = rows.filter((row) => readPath(row, path) === undefined).length;
    if (missingOn > 0) {
      problems.push(
        `${label} path '${path}' resolves to nothing on ${missingOn} of ` +
          `${rows.length} sampled products, and this field cannot be absent`,
      );
    }
  }

  for (const [label, path] of tolerantPaths(schema)) {
    if (!rows.some((row) => readPath(row, path) !== undefined)) {
      problems.push(
        `${label} path '${path}' resolves to nothing on any of the ` +
          `${rows.length} sampled products`,
      );
    }
  }

  // A unit that contradicts the value it reads. Two self-consistent readings cannot be
  // separated here, but an inconsistent one can.
  const priceRaw = readPath(rows[0], schema.product.price.path);
  if (typeof priceRaw === "string" && priceRaw.includes(".")) {
    if (schema.product.price.unit === "minor") {
      problems.push(
        `price unit 'minor' cannot be right: '${priceRaw}' contains a decimal point`,
      );
    }
  }

  if (problems.length > 0) return { ok: false, problems };

  // Finally, build the entity. This is where readMoney, the name check and the
  // stock-must-be-a-count rule all run.
  try {
    // Every sampled row, not just the first. A mapping that works on one product and
    // throws on the next is the failure a single-row check would have shipped.
    const adapter = new MerchantAdapter(schema, sampleTransport(rows, schema));
    const snapshot = await adapter.snapshot(idsFound);
    const built = idsFound
      .map((id) => snapshot.getProduct(id))
      .filter((p): p is Product => p !== undefined);
    if (built.length !== idsFound.length) {
      return {
        ok: false,
        problems: [
          `mapping produced ${built.length} products from ${idsFound.length} sampled rows`,
        ],
      };
    }
    return { ok: true, product: built[0]! };
  } catch (error) {
    return {
      ok: false,
      problems: [error instanceof Error ? error.message : String(error)],
    };
  }
}

/** Paths whose absence makes the adapter throw, so they must be on every row. */
function requiredPaths(schema: MerchantSchema): Array<[string, string]> {
  const paths: Array<[string, string]> = [
    ["product.name", schema.product.name],
    ["product.price", schema.product.price.path],
  ];
  if (schema.product.minPrice) paths.push(["product.minPrice", schema.product.minPrice.path]);
  if (schema.product.priceVersion) {
    paths.push(["product.priceVersion", schema.product.priceVersion]);
  }
  if (schema.inventory.available) {
    paths.push(["inventory.available", schema.inventory.available]);
  }
  if (schema.inventory.version) paths.push(["inventory.version", schema.inventory.version]);
  return paths;
}

/** Paths declared with `whenMissing`, so absence on a given row is legitimate. */
function tolerantPaths(schema: MerchantSchema): Array<[string, string]> {
  const paths: Array<[string, string]> = [];
  if (schema.product.allergens) {
    paths.push(["product.allergens", schema.product.allergens.path]);
  }
  if (schema.product.vegan) paths.push(["product.vegan", schema.product.vegan.path]);
  if (schema.product.bundleEligible) {
    paths.push(["product.bundleEligible", schema.product.bundleEligible.path]);
  }
  if (schema.product.category) paths.push(["product.category", schema.product.category.path]);
  return paths;
}

/**
 * Finds the product objects in a response of unknown shape.
 *
 * Tries the transport's declared root first, then the common envelopes, then treats the
 * body as a single product. Deliberately not part of the mapping DSL: this is only used
 * to validate a proposal against one sample, where guessing wrong costs a rejection
 * message rather than a wrong price.
 */
function rowsFrom(sample: unknown): unknown[] {
  if (Array.isArray(sample)) return sample;
  for (const path of ["data.products", "data.items", "products", "items", "data"]) {
    const found = readPath(sample, path);
    if (Array.isArray(found) && found.length > 0) return found;
    if (found && typeof found === "object" && !Array.isArray(found)) return [found];
  }
  return sample && typeof sample === "object" ? [sample] : [];
}

/** Serves the sample rows, so validation needs no network. */
function sampleTransport(rows: unknown[], schema: MerchantSchema): CatalogTransport {
  return {
    kind: "sample",
    async fetch(ids) {
      const out = new Map<string, unknown>();
      for (const row of rows) {
        const id = readPath(row, schema.product.id);
        if ((typeof id === "string" || typeof id === "number") && ids.includes(String(id))) {
          out.set(String(id), row);
        }
      }
      return out;
    },
  };
}

/** Used only to read capabilities off an adapter; never fetches. */
function nullTransport(): CatalogTransport {
  return { kind: "none", async fetch() { return new Map(); } };
}

/**
 * Pulls JSON out of a reply that may be fenced or prefaced.
 *
 * Models asked for JSON still return it inside a ```json block often enough that
 * failing on it would make this feature flaky for no reason.
 */
function extractJson(content: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(content);
  const text = (fenced?.[1] ?? content).trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}
