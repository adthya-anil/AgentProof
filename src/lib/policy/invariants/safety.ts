import { type Invariant, escalate, pass, skip, violation } from "./types.js";

/**
 * Missing product-safety data must never be read as "safe".
 *
 * `allergens: null` means the merchant has not supplied the data. `[]` means it
 * has been verified free of allergens. An integration that coalesces the two
 * (`product.allergens ?? []`) will cheerfully sell an unknown imported truffle
 * box to someone with a peanut allergy.
 *
 * Three outcomes are possible here, and the distinction matters for honest
 * measurement:
 *  - a *known* allergen conflict is a critical violation;
 *  - *unknown* data under `escalate` policy is an escalation — the Guard
 *    correctly declines to decide, which is a safe rejection, not a defect;
 *  - unknown data under `block` policy is a violation.
 */
export const productSafetyInvariant: Invariant = {
  id: "INV-PRODUCT-SAFETY",
  title: "Unknown product-safety data is never treated as safe",
  severity: "critical",
  policyRefs: [
    "products.unknown_allergen_status",
    "products.substitutions_require_approval",
  ],
  attribution: "integration",
  appliesAt: ["quote.created", "checkout.requested"],
  evaluate(ctx) {
    const quote = ctx.quote;
    if (!quote) return skip("No quote to evaluate");

    const avoid = ctx.intent.constraints.mustAvoidAllergens.map((a) =>
      a.toLowerCase(),
    );
    const requireVegan = ctx.intent.constraints.requireVegan;
    if (avoid.length === 0 && !requireVegan) {
      return skip("Buyer stated no dietary or allergen constraints");
    }

    const conflicts: Array<Record<string, unknown>> = [];
    const unknowns: Array<Record<string, unknown>> = [];

    for (const line of quote.lineItems) {
      const product = ctx.catalog.getProduct(line.productId);
      if (!product) continue;

      // Allergens.
      if (avoid.length > 0) {
        if (product.allergens === null) {
          unknowns.push({
            productId: product.id,
            name: product.name,
            field: "allergens",
            buyerMustAvoid: avoid,
          });
        } else {
          const hits = product.allergens
            .map((a) => a.toLowerCase())
            .filter((a) => avoid.includes(a));
          if (hits.length > 0) {
            conflicts.push({
              productId: product.id,
              name: product.name,
              field: "allergens",
              matched: hits,
            });
          }
        }
      }

      // Vegan status.
      if (requireVegan) {
        if (product.vegan === null) {
          unknowns.push({
            productId: product.id,
            name: product.name,
            field: "vegan",
          });
        } else if (product.vegan === false) {
          conflicts.push({
            productId: product.id,
            name: product.name,
            field: "vegan",
            matched: ["not_vegan"],
          });
        }
      }
    }

    if (conflicts.length > 0) {
      return violation({
        message:
          `Bundle violates a stated buyer safety constraint: ` +
          conflicts
            .map((c) =>
              c.field === "vegan"
                ? `${c.name} is not vegan`
                : `${c.name} contains ${(c.matched as string[]).join(", ")}`,
            )
            .join("; ") +
          `. Buyer constraints: ` +
          `${requireVegan ? "vegan required; " : ""}avoid ${avoid.join(", ") || "none"}.`,
        observed: { conflicts },
        expected: {
          requireVegan,
          mustAvoidAllergens: avoid,
          conflictingLines: 0,
        },
        moneyAtRiskMinor: quote.totalMinor,
        remediation:
          "Filter candidate products by the buyer's stated constraints before " +
          "bundling.",
      });
    }

    if (unknowns.length > 0) {
      const mode = ctx.policy.products.unknownAllergenStatus;
      const detail = {
        message:
          `Product safety data is missing for ` +
          unknowns
            .map((u) => `${u.name} (${u.field} unknown)`)
            .join("; ") +
          `, and the buyer requires ` +
          `${requireVegan ? "vegan items" : ""}` +
          `${requireVegan && avoid.length ? " and " : ""}` +
          `${avoid.length ? `no ${avoid.join(", ")}` : ""}. ` +
          `Missing data cannot be interpreted as safe.`,
        observed: { unknowns, unknownAllergenStatus: mode },
        expected: { safetyDataKnownForAllConstrainedLines: true },
        moneyAtRiskMinor: quote.totalMinor,
        remediation:
          "Treat a null allergen or vegan field as unknown, not empty. Exclude " +
          "the product or route it for human confirmation.",
      };

      if (mode === "allow") {
        return pass("Unknown safety data permitted by policy");
      }
      // 'escalate' is a correct, safe outcome — not an integration defect.
      return mode === "escalate"
        ? escalate({ ...detail, severity: "high" })
        : violation(detail);
    }

    return pass("All lines satisfy the buyer's safety constraints");
  },
};
