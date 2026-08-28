import { formatMinor } from "../../core/money.js";
import { quoteContentHash } from "../../core/quoteHash.js";
import { type Invariant, pass, skip, violation } from "./types.js";

/**
 * The amount charged must correspond to prices that are still live, and to the
 * exact quote the buyer approved.
 *
 * Three independent bindings are checked, because each fails differently:
 *  1. price *version* drift — the catalog moved since the quote was priced;
 *  2. approval → quote version binding — the receipt points at an older pricing;
 *  3. content hash — what is being bought changed even if the total did not
 *     (a substitution that happens to cost the same).
 *
 * Comparing versions rather than only amounts matters: two different baskets can
 * total the same rupees, and an amount-only check would wave that through.
 */
export const priceBindingInvariant: Invariant = {
  id: "INV-PRICE-BINDING",
  title: "Checkout price matches the currently valid approved quote",
  severity: "critical",
  policyRefs: [
    "pricing.payment_must_equal_approved_quote",
    "products.substitutions_require_approval",
  ],
  attribution: "integration",
  appliesAt: ["checkout.requested"],
  /**
   * The rule is a version comparison, so without a version there is nothing to
   * compare. Left to run against a merchant with no price version it would read
   * undefined on both sides, find them equal, and report that the price is still
   * bound — the single most expensive false pass this engine could produce.
   */
  requires: ["product.lookup", "product.priceVersion", "approval.contentHash"],
  evaluate(ctx) {
    const quote = ctx.quote;
    if (!quote) return skip("No quote to evaluate");

    // 1. Has the live catalog moved since this quote was priced?
    const drifted: Array<Record<string, unknown>> = [];
    let recomputedSubtotal = 0;

    for (const line of quote.lineItems) {
      const product = ctx.catalog.getProduct(line.productId);
      if (!product) {
        drifted.push({
          productId: line.productId,
          name: line.name,
          issue: "product_removed",
        });
        continue;
      }
      recomputedSubtotal += product.priceMinor * line.quantity;
      if (
        product.priceVersion !== line.priceVersion ||
        product.priceMinor !== line.unitPriceMinor
      ) {
        drifted.push({
          productId: line.productId,
          name: line.name,
          issue: "price_changed",
          quotedUnitPriceMinor: line.unitPriceMinor,
          currentUnitPriceMinor: product.priceMinor,
          quotedPriceVersion: line.priceVersion,
          currentPriceVersion: product.priceVersion,
        });
      }
    }

    if (drifted.length > 0) {
      const delta = recomputedSubtotal - quote.subtotalMinor;
      return violation({
        message:
          `Catalog prices changed after this quote was priced. ` +
          drifted
            .map((d) =>
              d.issue === "price_changed"
                ? `${d.name}: quoted ${formatMinor(
                    d.quotedUnitPriceMinor as number,
                  )} (v${d.quotedPriceVersion}) but current price is ` +
                  `${formatMinor(d.currentUnitPriceMinor as number)} (v${d.currentPriceVersion})`
                : `${d.name}: no longer in catalog`,
            )
            .join("; ") +
          `. Quote total ${formatMinor(quote.totalMinor)} is stale.`,
        observed: {
          driftedLines: drifted,
          quotedSubtotalMinor: quote.subtotalMinor,
          currentSubtotalMinor: recomputedSubtotal,
        },
        expected: { priceVersionsUnchangedSinceQuote: true },
        moneyAtRiskMinor: Math.abs(delta),
        remediation:
          "Re-price the quote against the live catalog and obtain fresh buyer " +
          "approval before creating a payment.",
      });
    }

    // 2. Does the approval point at this exact quote version?
    if (ctx.approval) {
      if (
        ctx.approval.quoteId !== quote.id ||
        ctx.approval.quoteVersion !== quote.version
      ) {
        return violation({
          message:
            `Approval receipt ${ctx.approval.id} is bound to quote ` +
            `${ctx.approval.quoteId} v${ctx.approval.quoteVersion}, but checkout ` +
            `is using ${quote.id} v${quote.version}.`,
          observed: {
            approvedQuoteId: ctx.approval.quoteId,
            approvedQuoteVersion: ctx.approval.quoteVersion,
            checkoutQuoteId: quote.id,
            checkoutQuoteVersion: quote.version,
          },
          expected: { approvalBoundToCheckoutQuoteVersion: true },
          moneyAtRiskMinor: quote.totalMinor,
          remediation: "Request approval for the re-priced quote.",
        });
      }

      // 3. Is the basket still exactly what the buyer saw?
      const currentHash = quoteContentHash(quote);
      if (currentHash !== ctx.approval.approvedContentHash) {
        return violation({
          message:
            `The basket changed after approval. The buyer approved a different ` +
            `set of items or prices than the one being charged, even though the ` +
            `quote version was reused.`,
          observed: { currentContentHash: currentHash },
          expected: { approvedContentHash: ctx.approval.approvedContentHash },
          moneyAtRiskMinor: quote.totalMinor,
          remediation:
            "Treat any substitution as a new quote requiring fresh approval.",
        });
      }
    }

    // 4. Internal arithmetic consistency of the quote itself.
    const expectedTotal = quote.subtotalMinor - quote.totalDiscountMinor;
    if (expectedTotal !== quote.totalMinor) {
      return violation({
        message:
          `Quote arithmetic is inconsistent: subtotal ` +
          `${formatMinor(quote.subtotalMinor)} minus discounts ` +
          `${formatMinor(quote.totalDiscountMinor)} is ` +
          `${formatMinor(expectedTotal)}, but the payable total says ` +
          `${formatMinor(quote.totalMinor)}.`,
        observed: { totalMinor: quote.totalMinor },
        expected: { totalMinor: expectedTotal },
        moneyAtRiskMinor: Math.abs(quote.totalMinor - expectedTotal),
        remediation: "Fix the pricing engine's total computation.",
      });
    }

    return pass("Price, version and content bindings all intact");
  },
};
