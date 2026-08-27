import { allocateDiscount } from "../core/allocation.js";
import {
  type Minor,
  effectiveDiscountPercent,
  percentOf,
  roundPercent,
  rupees,
} from "../core/money.js";
import type { DiscountComponent, DiscountKind } from "../core/types.js";
import type { MutationSet } from "./mutations.js";

export interface PromoDefinition {
  code: string;
  label: string;
  kind: DiscountKind;
  /** Percent promos set `percent`; flat credits set `flatMinor`. */
  percent?: number;
  flatMinor?: Minor;
  minItems?: number;
}

/**
 * HamperHub's promotion catalog.
 *
 * `HAMPERCREDIT` is a flat ₹47 packing credit (the happy-path discount).
 * `HAMPER4` + `LOYAL49` are the pair that stacks to 8.7% when applied
 * sequentially, which is seeded defect #1.
 */
export const PROMOS: Readonly<Record<string, PromoDefinition>> = Object.freeze({
  HAMPERCREDIT: {
    code: "HAMPERCREDIT",
    label: "Hamper packing credit",
    kind: "bundle",
    flatMinor: rupees(47),
    minItems: 4,
  },
  HAMPER4: {
    code: "HAMPER4",
    label: "Bundle discount",
    kind: "bundle",
    percent: 4,
    minItems: 4,
  },
  LOYAL49: {
    code: "LOYAL49",
    label: "Loyalty discount",
    kind: "loyalty",
    percent: 4.9,
  },
  WELCOME3: {
    code: "WELCOME3",
    label: "Welcome offer",
    kind: "promo",
    percent: 3,
  },
  FESTIVE10: {
    code: "FESTIVE10",
    label: "Festive offer",
    kind: "promo",
    percent: 10,
  },
});

/** Discounts apply in this order so results are reproducible. */
const KIND_ORDER: Record<DiscountKind, number> = {
  bundle: 0,
  loyalty: 1,
  promo: 2,
};

export interface PricingConfig {
  maxDiscountPercent: number;
  allowStacking: boolean;
}

export interface RejectedPromo {
  code: string;
  reason: string;
}

export interface PricingResult {
  subtotalMinor: Minor;
  discounts: DiscountComponent[];
  totalDiscountMinor: Minor;
  totalMinor: Minor;
  effectivePercent: number;
  rejectedPromos: RejectedPromo[];
}

export interface PricingLine {
  productId: string;
  quantity: number;
  unitPriceMinor: Minor;
  lineTotalMinor: Minor;
  minPriceMinor: Minor;
}

/**
 * Applies promotions to a bundle.
 *
 * Discounts are applied *sequentially* against the running total, which is how
 * most real promotion engines behave. The bug is not the sequencing — it is
 * validating each component's own rate against the cap instead of validating
 * the resulting effective discount.
 *
 * When `discount_stacking` is active the integration does the naive per-component
 * check and happily returns an 8.7% total. When it is not active the integration
 * checks the cumulative effective rate and rejects the offending components.
 */
export function computePricing(
  lines: readonly PricingLine[],
  promoCodes: readonly string[],
  config: PricingConfig,
  mutations: MutationSet,
): PricingResult {
  const subtotalMinor = lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);
  const itemCount = lines.reduce((sum, line) => sum + line.quantity, 0);

  const requested = [...new Set(promoCodes)]
    .map((code) => PROMOS[code.toUpperCase()])
    .filter((promo): promo is PromoDefinition => Boolean(promo))
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);

  const rejectedPromos: RejectedPromo[] = [];
  for (const code of promoCodes) {
    if (!PROMOS[code.toUpperCase()]) {
      rejectedPromos.push({ code, reason: "Unknown promotion code" });
    }
  }

  const naiveStacking = mutations.has("discount_stacking");
  const discounts: DiscountComponent[] = [];
  let running = subtotalMinor;

  for (const promo of requested) {
    if (promo.minItems && itemCount < promo.minItems) {
      rejectedPromos.push({
        code: promo.code,
        reason: `Requires at least ${promo.minItems} items, bundle has ${itemCount}`,
      });
      continue;
    }

    // The merchant's own stacking rule, independent of the cap.
    if (!config.allowStacking && !naiveStacking && discounts.length >= 1) {
      rejectedPromos.push({
        code: promo.code,
        reason: "Discount stacking is not permitted by merchant policy",
      });
      continue;
    }

    const amountMinor =
      promo.flatMinor !== undefined
        ? Math.min(promo.flatMinor, running)
        : percentOf(running, promo.percent ?? 0);

    if (amountMinor <= 0) {
      rejectedPromos.push({ code: promo.code, reason: "No discount value" });
      continue;
    }

    const component: DiscountComponent = {
      code: promo.code,
      label: promo.label,
      kind: promo.kind,
      percent: promo.percent ?? 0,
      amountMinor,
      appliedToMinor: running,
    };

    if (naiveStacking) {
      // The defect: each component is judged on its own rate only.
      const ownPercent =
        promo.percent ?? (subtotalMinor > 0 ? (amountMinor / subtotalMinor) * 100 : 0);
      if (ownPercent > config.maxDiscountPercent) {
        rejectedPromos.push({
          code: promo.code,
          reason: `Component rate ${roundPercent(ownPercent)}% exceeds cap`,
        });
        continue;
      }
    } else {
      // Correct behaviour: would the cumulative effective rate breach the cap?
      const prospectiveTotal = running - amountMinor;
      const prospectivePercent = effectiveDiscountPercent(
        subtotalMinor,
        prospectiveTotal,
      );
      if (prospectivePercent > config.maxDiscountPercent + 1e-9) {
        rejectedPromos.push({
          code: promo.code,
          reason:
            `Cumulative discount would reach ${roundPercent(prospectivePercent)}%, ` +
            `above the ${config.maxDiscountPercent}% cap`,
        });
        continue;
      }
    }

    discounts.push(component);
    running -= amountMinor;
  }

  const totalDiscountMinor = subtotalMinor - running;
  return {
    subtotalMinor,
    discounts,
    totalDiscountMinor,
    totalMinor: running,
    effectivePercent: effectiveDiscountPercent(subtotalMinor, running),
    rejectedPromos,
  };
}

/** Lines whose post-discount value falls under the merchant's floor price. */
export function findFloorPriceBreaches(
  lines: readonly PricingLine[],
  totalDiscountMinor: Minor,
): Array<{ productId: string; floorMinor: Minor; effectiveMinor: Minor }> {
  const allocations = allocateDiscount(
    lines.map((line) => line.lineTotalMinor),
    totalDiscountMinor,
  );
  const breaches: Array<{
    productId: string;
    floorMinor: Minor;
    effectiveMinor: Minor;
  }> = [];

  lines.forEach((line, index) => {
    const effective = line.lineTotalMinor - (allocations[index] ?? 0);
    const floor = line.minPriceMinor * line.quantity;
    if (effective < floor) {
      breaches.push({
        productId: line.productId,
        floorMinor: floor,
        effectiveMinor: effective,
      });
    }
  });
  return breaches;
}
