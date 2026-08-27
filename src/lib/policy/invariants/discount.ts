import { allocateDiscount } from "../../core/allocation.js";
import {
  effectiveDiscountPercent,
  formatMinor,
  roundPercent,
} from "../../core/money.js";
import { type Invariant, pass, skip, violation } from "./types.js";

/**
 * The discount cap applies to the *effective* discount, not to any individual
 * component.
 *
 * This is computed from the two endpoints — subtotal and payable total — so it
 * is immune to however the merchant chose to layer its promotions. Summing the
 * declared component rates is precisely the mistake that lets 4% + 4.9% pass a
 * 5% cap; measuring the endpoints reports the true 8.7%.
 */
export const discountCapInvariant: Invariant = {
  id: "INV-DISCOUNT-CAP",
  title: "Effective combined discount stays within the merchant's cap",
  severity: "critical",
  policyRefs: [
    "pricing.maximum_discount_percent",
    "pricing.allow_discount_stacking",
  ],
  attribution: "integration",
  appliesAt: ["quote.created", "checkout.requested"],
  evaluate(ctx) {
    const quote = ctx.quote;
    if (!quote) return skip("No quote to evaluate");

    const cap = ctx.policy.pricing.maximumDiscountPercent;
    const effective = effectiveDiscountPercent(
      quote.subtotalMinor,
      quote.totalMinor,
    );

    // Float tolerance: never fail a quote for a rounding artefact.
    if (effective > cap + 1e-9) {
      const components = quote.discounts.map(
        (d) =>
          `${d.code} ${d.percent > 0 ? `${d.percent}%` : formatMinor(d.amountMinor)}` +
          ` on ${formatMinor(d.appliedToMinor)} = -${formatMinor(d.amountMinor)}`,
      );
      const cappedTotal =
        quote.subtotalMinor - Math.floor((quote.subtotalMinor * cap) / 100);
      return violation({
        message:
          `Effective discount reached ${roundPercent(effective)}% against a ` +
          `${cap}% policy limit. Subtotal ${formatMinor(quote.subtotalMinor)} ` +
          `discounted to ${formatMinor(quote.totalMinor)} by ` +
          `${quote.discounts.length} components applied in sequence.`,
        observed: {
          effectiveDiscountPercent: roundPercent(effective),
          subtotalMinor: quote.subtotalMinor,
          totalMinor: quote.totalMinor,
          totalDiscountMinor: quote.totalDiscountMinor,
          components,
        },
        expected: {
          maximumDiscountPercent: cap,
          maximumTotalDiscountMinor: Math.floor(
            (quote.subtotalMinor * cap) / 100,
          ),
        },
        moneyAtRiskMinor: Math.max(0, cappedTotal - quote.totalMinor),
        remediation:
          "Validate the cumulative effective discount after applying every " +
          "component, not each component's own rate.",
      });
    }

    if (
      !ctx.policy.pricing.allowDiscountStacking &&
      quote.discounts.length > 1
    ) {
      return violation({
        message:
          `${quote.discounts.length} discounts were combined but the merchant ` +
          `policy forbids stacking: ` +
          `${quote.discounts.map((d) => d.code).join(" + ")}.`,
        observed: { appliedCodes: quote.discounts.map((d) => d.code) },
        expected: { allowDiscountStacking: false, maximumComponents: 1 },
        moneyAtRiskMinor: quote.discounts
          .slice(1)
          .reduce((sum, d) => sum + d.amountMinor, 0),
        severity: "high",
        remediation: "Apply only the single best-value promotion.",
      });
    }

    return pass(`Effective discount ${roundPercent(effective)}% within ${cap}%`);
  },
};

/**
 * No line may be discounted below the merchant's minimum permitted price.
 *
 * A bundle can respect the overall cap while a proportional allocation pushes
 * one scarce item under its floor, so this is checked per line rather than in
 * aggregate.
 */
export const floorPriceInvariant: Invariant = {
  id: "INV-FLOOR-PRICE",
  title: "No line item is discounted below its minimum permitted price",
  severity: "high",
  policyRefs: ["pricing.enforce_floor_price"],
  attribution: "integration",
  appliesAt: ["quote.created", "checkout.requested"],
  evaluate(ctx) {
    if (!ctx.policy.pricing.enforceFloorPrice) {
      return skip("Floor-price enforcement disabled by policy");
    }
    const quote = ctx.quote;
    if (!quote) return skip("No quote to evaluate");
    if (quote.totalDiscountMinor <= 0) return pass("No discount applied");

    const allocations = allocateDiscount(
      quote.lineItems.map((line) => line.lineTotalMinor),
      quote.totalDiscountMinor,
    );

    const breaches: Array<Record<string, unknown>> = [];
    let atRisk = 0;

    quote.lineItems.forEach((line, index) => {
      const product = ctx.catalog.getProduct(line.productId);
      if (!product) return;
      const effective = line.lineTotalMinor - (allocations[index] ?? 0);
      const floor = product.minPriceMinor * line.quantity;
      if (effective < floor) {
        atRisk += floor - effective;
        breaches.push({
          productId: line.productId,
          name: line.name,
          effectiveMinor: effective,
          floorMinor: floor,
        });
      }
    });

    if (breaches.length > 0) {
      return violation({
        message:
          `${breaches.length} line item(s) fall below the merchant's minimum ` +
          `permitted price after discount allocation: ` +
          breaches
            .map(
              (b) =>
                `${b.name} at ${formatMinor(b.effectiveMinor as number)} ` +
                `(floor ${formatMinor(b.floorMinor as number)})`,
            )
            .join("; ") +
          ".",
        observed: { breaches },
        expected: { allLinesAtOrAboveFloor: true },
        moneyAtRiskMinor: atRisk,
        remediation:
          "Cap the per-line discount at each product's minimum permitted price.",
      });
    }

    return pass("All lines at or above floor price");
  },
};
