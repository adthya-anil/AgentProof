import { ManualClock } from "../core/clock.js";
import { IdFactory } from "../core/ids.js";
import { HAMPERHUB, type Merchant } from "../core/entities.js";
import type { Minor } from "../core/money.js";
import type { ProductCategory } from "../core/types.js";
import { PROMOS } from "../hamperhub/pricing.js";
import { MerchantState } from "../hamperhub/state.js";
import { TOOL_DECLARATIONS } from "../hamperhub/tools.js";

/**
 * Storefront view of HamperHub.
 *
 * The dashboard is otherwise entirely AgentProof-facing. This is the merchant
 * *under test*, rendered so a human can see exactly what an AI buyer is given:
 * the catalog, the tool surface, and the promotions. Without it the integration
 * is invisible, and a reviewer has to take the report's word for what was being
 * tested.
 *
 * Most importantly it makes tri-state product data visible. An allergen field
 * that is genuinely unknown looks different here from one verified as empty,
 * which is the whole basis of the product-safety invariant.
 */

export type SafetyState = "known" | "unknown";

export interface StorefrontProduct {
  id: string;
  name: string;
  category: ProductCategory;
  priceMinor: Minor;
  /** Floor below which the merchant will not sell after discounts. */
  minPriceMinor: Minor;
  available: number;
  /** null means the merchant published no allergen data at all. */
  allergens: string[] | null;
  allergenState: SafetyState;
  vegan: boolean | null;
  veganState: SafetyState;
  bundleEligible: boolean;
  /** True when any safety field is unpublished. Drives the warning styling. */
  hasUnknownSafetyData: boolean;
}

export interface StorefrontPromo {
  code: string;
  label: string;
  kind: string;
  /** Human-readable value: "4%" or "₹47 off". */
  value: string;
  minItems: number | null;
}

export interface StorefrontTool {
  name: string;
  description: string;
  /** Parameter names, in declaration order, for a compact signature. */
  parameters: string[];
  required: string[];
}

export interface Storefront {
  merchant: Merchant;
  products: StorefrontProduct[];
  categories: ProductCategory[];
  promos: StorefrontPromo[];
  tools: StorefrontTool[];
  totalUnitsInStock: number;
  unknownSafetyCount: number;
}

/**
 * Builds the storefront from seed state.
 *
 * Deliberately a fresh `MerchantState` rather than any live run's state: this
 * page describes the integration as shipped, not a snapshot mid-journey. Prices
 * and stock move constantly during a run, and showing those here would suggest
 * the catalog itself was mutating under the reader.
 */
export function getStorefront(): Storefront {
  const state = new MerchantState(new ManualClock(), new IdFactory("storefront"));

  const products: StorefrontProduct[] = state.listProducts().map((product) => {
    const inventory = state.requireInventory(product.id);
    const allergenState: SafetyState =
      product.allergens === null ? "unknown" : "known";
    const veganState: SafetyState = product.vegan === null ? "unknown" : "known";

    return {
      id: product.id,
      name: product.name,
      category: product.category,
      priceMinor: product.priceMinor,
      minPriceMinor: product.minPriceMinor,
      available: inventory.available,
      allergens: product.allergens,
      allergenState,
      veganState,
      vegan: product.vegan,
      bundleEligible: product.bundleEligible,
      hasUnknownSafetyData:
        allergenState === "unknown" || veganState === "unknown",
    };
  });

  const promos: StorefrontPromo[] = Object.values(PROMOS).map((promo) => ({
    code: promo.code,
    label: promo.label,
    kind: promo.kind,
    value:
      promo.percent !== undefined
        ? `${promo.percent}%`
        : `₹${(promo.flatMinor ?? 0) / 100} off`,
    minItems: promo.minItems ?? null,
  }));

  const tools: StorefrontTool[] = TOOL_DECLARATIONS.map((tool) => {
    const params = tool.parameters as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    return {
      name: tool.name,
      description: tool.description,
      parameters: Object.keys(params.properties ?? {}),
      required: params.required ?? [],
    };
  });

  return {
    merchant: HAMPERHUB,
    products,
    categories: [...new Set(products.map((p) => p.category))].sort(),
    promos,
    tools,
    totalUnitsInStock: products.reduce((sum, p) => sum + p.available, 0),
    unknownSafetyCount: products.filter((p) => p.hasUnknownSafetyData).length,
  };
}

/** Formats allergen data for display, distinguishing unknown from verified-none. */
export function describeAllergens(product: StorefrontProduct): string {
  if (product.allergens === null) return "not published";
  if (product.allergens.length === 0) return "none declared";
  return product.allergens.join(", ");
}

export function describeVegan(product: StorefrontProduct): string {
  if (product.vegan === null) return "not published";
  return product.vegan ? "vegan" : "not vegan";
}
