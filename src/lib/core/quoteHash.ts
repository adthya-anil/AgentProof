import { stableHash } from "./ids.js";
import type { Quote, QuoteLineItem } from "./types.js";

/**
 * Hash of exactly what a buyer was shown when they approved.
 *
 * Covers products, quantities, unit prices and the payable total — the facts a
 * buyer would care about. Deliberately excludes quote id, timestamps and expiry
 * so that re-hashing a quote after a *cosmetic* change still matches, while any
 * change to what is bought or what it costs does not.
 *
 * The approval receipt stores this hash, so a substitution or re-price after
 * approval is detectable even if the total happens to be unchanged.
 */
export function quoteContentHash(quote: {
  lineItems: readonly QuoteLineItem[];
  totalMinor: number;
  currency: string;
}): string {
  return stableHash({
    currency: quote.currency,
    totalMinor: quote.totalMinor,
    lines: [...quote.lineItems]
      .map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
        unitPriceMinor: line.unitPriceMinor,
      }))
      .sort((a, b) => (a.productId < b.productId ? -1 : 1)),
  });
}

export function describeQuote(quote: Quote): string {
  return quote.lineItems
    .map((line) => `${line.quantity}x ${line.name}`)
    .join(", ");
}
