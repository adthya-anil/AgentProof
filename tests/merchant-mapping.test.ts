import { describe, expect, it } from "vitest";
import {
  MappingError,
  derivedVersion,
  parseMerchantSchema,
  readList,
  readMoney,
  readPath,
  readTriState,
} from "../src/lib/merchant/mapping.js";

/**
 * The mapping DSL.
 *
 * Everything here is about refusing to guess. A merchant returning `1299` might mean
 * ₹1,299.00 or ₹12.99 and nothing in the value says which; a missing allergen list might
 * mean "none" or "we do not track that". Both guesses are a hundredfold error or a
 * hospital visit, so the DSL requires the answer and this file proves it.
 */

describe("path reading", () => {
  const source = {
    id: "p-1",
    stock: { count: 4, nested: { deep: "yes" } },
    variants: [{ price: "12.99" }, { price: "24.50" }],
  };

  it("reads dotted paths", () => {
    expect(readPath(source, "stock.count")).toBe(4);
    expect(readPath(source, "stock.nested.deep")).toBe("yes");
  });

  it("reads array indices", () => {
    expect(readPath(source, "variants[0].price")).toBe("12.99");
    expect(readPath(source, "variants[1].price")).toBe("24.50");
  });

  it("returns undefined for an absent path rather than throwing", () => {
    // A missing field is a legitimate answer the capability layer acts on. Throwing
    // this deep would take the decision away from the caller.
    expect(readPath(source, "stock.missing")).toBeUndefined();
    expect(readPath(source, "nope.nothing.here")).toBeUndefined();
  });

  it("returns undefined rather than crashing on a type mismatch", () => {
    expect(readPath(source, "id.length.deeper")).toBeUndefined();
    expect(readPath(source, "stock[0]")).toBeUndefined();
    expect(readPath(null, "a.b")).toBeUndefined();
  });
});

describe("money", () => {
  it("reads minor units unchanged", () => {
    expect(readMoney({ p: 1299 }, { path: "p", unit: "minor" })).toBe(1299);
  });

  it("scales major units", () => {
    expect(readMoney({ p: 1299 }, { path: "p", unit: "major" })).toBe(129900);
  });

  it("does not lose a paise to binary floating point", () => {
    /**
     * The case that makes `decimalString` its own unit. `parseFloat("12.99") * 100` is
     * 1298.9999999999998, and a Math.round somewhere else in the pipeline would make
     * this look fine right up until a value rounded the other way.
     */
    expect(readMoney({ p: "12.99" }, { path: "p", unit: "decimalString" })).toBe(1299);
    expect(readMoney({ p: "0.01" }, { path: "p", unit: "decimalString" })).toBe(1);
    expect(readMoney({ p: "1234.56" }, { path: "p", unit: "decimalString" })).toBe(
      123456,
    );
  });

  it("handles a decimal string with no fraction, or one digit", () => {
    expect(readMoney({ p: "12" }, { path: "p", unit: "decimalString" })).toBe(1200);
    expect(readMoney({ p: "12.9" }, { path: "p", unit: "decimalString" })).toBe(1290);
  });

  it("throws rather than defaulting to zero when a price is missing", () => {
    /**
     * The most important assertion in this file. A price that cannot be read is not
     * free. A zero would flow into a quote, satisfy the floor-price rule for entirely
     * the wrong reason, and let an agent buy a hamper for nothing.
     */
    expect(() => readMoney({}, { path: "price", unit: "minor" })).toThrow(MappingError);
    expect(() => readMoney({ price: null }, { path: "price", unit: "minor" })).toThrow(
      /no value for a required money field/,
    );
  });

  it("names the path it failed on", () => {
    // A mapping has dozens of paths; "could not read money" would send someone
    // hunting through all of them.
    expect(() =>
      readMoney({}, { path: "priceRange.minVariantPrice.amount", unit: "minor" }),
    ).toThrow(/priceRange\.minVariantPrice\.amount/);
  });

  it("rejects a minor value that is not an integer", () => {
    // 12.5 paise does not exist. Silently truncating would lose money by a rounding
    // rule nobody chose.
    expect(() => readMoney({ p: 12.5 }, { path: "p", unit: "minor" })).toThrow(
      /not an integer/,
    );
  });

  it("rejects a major value that is not a whole number of paise", () => {
    expect(() => readMoney({ p: 12.999 }, { path: "p", unit: "major" })).toThrow(
      /not a whole number of paise/,
    );
  });

  it("rejects text that is not a number", () => {
    expect(() => readMoney({ p: "₹1,299" }, { path: "p", unit: "minor" })).toThrow(
      /not a finite number/,
    );
    expect(() =>
      readMoney({ p: "twelve" }, { path: "p", unit: "decimalString" }),
    ).toThrow(/not a decimal number/);
  });

  it("accepts a numeric string for minor units", () => {
    // Plenty of APIs quote integers as strings.
    expect(readMoney({ p: "1299" }, { path: "p", unit: "minor" })).toBe(1299);
  });
});

describe("tri-state booleans", () => {
  it("reads a real boolean", () => {
    expect(readTriState({ v: true }, { path: "v", whenMissing: "false" })).toBe(true);
    expect(readTriState({ v: false }, { path: "v", whenMissing: "true" })).toBe(false);
  });

  it("distinguishes unknown from false when the field is absent", () => {
    /**
     * The distinction that keeps an allergic buyer safe. "No allergen data" is not "no
     * allergens", and the existing tri-state logic already refuses to treat null as
     * safe — but only if the mapping preserves the difference instead of coercing to
     * false.
     */
    expect(readTriState({}, { path: "v", whenMissing: "unknown" })).toBeNull();
    expect(readTriState({}, { path: "v", whenMissing: "false" })).toBe(false);
    expect(readTriState({}, { path: "v", whenMissing: "true" })).toBe(true);
  });

  it("accepts the usual API spellings of true", () => {
    for (const value of ["yes", "Y", "true", 1, "1"]) {
      expect(readTriState({ v: value }, { path: "v", whenMissing: "false" })).toBe(true);
    }
  });

  it("treats an unlisted value as false rather than truthy", () => {
    // `Boolean("no")` is true, which is exactly the trap.
    expect(readTriState({ v: "no" }, { path: "v", whenMissing: "false" })).toBe(false);
    expect(readTriState({ v: "N" }, { path: "v", whenMissing: "false" })).toBe(false);
    expect(readTriState({ v: 0 }, { path: "v", whenMissing: "false" })).toBe(false);
  });

  it("honours a custom truthy list", () => {
    expect(
      readTriState({ v: "PLANT_BASED" }, {
        path: "v",
        whenMissing: "false",
        truthy: ["PLANT_BASED"],
      }),
    ).toBe(true);
  });
});

describe("lists", () => {
  it("reads an array", () => {
    expect(readList({ a: ["milk", "nuts"] }, { path: "a", whenMissing: "empty" })).toEqual(
      ["milk", "nuts"],
    );
  });

  it("distinguishes an empty list from no data", () => {
    expect(readList({}, { path: "a", whenMissing: "empty" })).toEqual([]);
    expect(readList({}, { path: "a", whenMissing: "unknown" })).toBeNull();
  });

  it("splits a delimited string when told to", () => {
    expect(
      readList({ a: "milk, nuts , soy" }, {
        path: "a",
        whenMissing: "empty",
        splitOn: ",",
      }),
    ).toEqual(["milk", "nuts", "soy"]);
  });

  it("does not split when no delimiter is declared", () => {
    // Guessing a delimiter would turn "milk chocolate" into two allergens.
    expect(readList({ a: "milk chocolate" }, { path: "a", whenMissing: "empty" })).toEqual(
      ["milk chocolate"],
    );
  });

  it("treats an empty string as an empty list", () => {
    expect(readList({ a: "  " }, { path: "a", whenMissing: "empty" })).toEqual([]);
  });
});

describe("derived versions", () => {
  it("is stable for the same content", () => {
    expect(derivedVersion(59900, "INR")).toBe(derivedVersion(59900, "INR"));
  });

  it("changes when the content changes", () => {
    // The whole basis for restoring INV-PRICE-BINDING against a merchant with no
    // version field: a price move must change the version.
    expect(derivedVersion(59900, "INR")).not.toBe(derivedVersion(64900, "INR"));
  });

  it("is always a non-negative integer, because the entity model says number", () => {
    for (const price of [0, 1, 59900, 999999999]) {
      const version = derivedVersion(price, "INR");
      expect(Number.isInteger(version)).toBe(true);
      expect(version).toBeGreaterThanOrEqual(0);
    }
  });

  it("cannot see a reverted change, which is the stated limitation", () => {
    /**
     * Pinned deliberately rather than left implicit. A native monotonic counter tells
     * ₹599 → ₹649 → ₹599 apart from an untouched ₹599; a content hash cannot. Sound for
     * the two rules that use it — each asks "is what I quoted still true", and after a
     * revert it is — but a rule that cared about a price's history could not use this,
     * and this test is where that would be noticed.
     */
    expect(derivedVersion(59900, "INR")).toBe(derivedVersion(59900, "INR"));
  });
});

describe("schema validation", () => {
  const minimal = {
    merchant: "acme",
    label: "Acme REST",
    currency: "INR",
    defaultCategory: "coffee",
    transport: {
      kind: "rest",
      baseUrl: "https://api.acme.test",
      productPath: "/products/{id}",
    },
    product: {
      id: "id",
      name: "title",
      price: { path: "price_cents", unit: "minor" },
    },
  };

  it("accepts a minimal mapping and applies defaults", () => {
    const schema = parseMerchantSchema(minimal);
    expect(schema.merchant).toBe("acme");
    expect(schema.supportsReservations).toBe(false);
    expect(schema.inventory).toEqual({});
    expect(schema.derive).toEqual({});
  });

  it("requires money units to be stated", () => {
    // No default. `1299` is ambiguous and the DSL must not resolve that ambiguity on
    // the author's behalf.
    expect(() =>
      parseMerchantSchema({
        ...minimal,
        product: { ...minimal.product, price: { path: "price_cents" } },
      }),
    ).toThrow();
  });

  it("requires a default category, since the union is closed", () => {
    const { defaultCategory, ...withoutCategory } = minimal;
    expect(defaultCategory).toBeDefined();
    expect(() => parseMerchantSchema(withoutCategory)).toThrow();
  });

  it("rejects a category outside the entity model's union", () => {
    expect(() =>
      parseMerchantSchema({ ...minimal, defaultCategory: "beverages" }),
    ).toThrow();
  });

  it("rejects a path with wildcards or filters", () => {
    /**
     * Not JSONPath on purpose. `variants[?(@.price<100)]` would let a mapping express
     * "the cheapest variant", which silently starts reading a different variant when a
     * price moves — so the thing that was quoted and the thing being checked would
     * diverge with no error anywhere.
     */
    for (const path of ["variants[*].price", "$.price", "a..b", "items[?(@.x)]"]) {
      expect(() =>
        parseMerchantSchema({
          ...minimal,
          product: { ...minimal.product, name: path },
        }),
        `should reject '${path}'`,
      ).toThrow();
    }
  });

  it("rejects a non-URL base", () => {
    expect(() =>
      parseMerchantSchema({
        ...minimal,
        transport: { ...minimal.transport, baseUrl: "api.acme.test" },
      }),
    ).toThrow();
  });

  it("requires whenMissing on optional tri-state and list fields", () => {
    expect(() =>
      parseMerchantSchema({
        ...minimal,
        product: { ...minimal.product, vegan: { path: "is_vegan" } },
      }),
    ).toThrow();
    expect(() =>
      parseMerchantSchema({
        ...minimal,
        product: { ...minimal.product, allergens: { path: "allergens" } },
      }),
    ).toThrow();
  });
});
