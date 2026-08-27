import type { Minor } from "./money.js";

/**
 * Splits a total discount across lines proportionally to line value using the
 * largest-remainder method, so the parts sum to exactly the whole.
 *
 * Lives in `core` because both the merchant's pricing engine and the Guard's
 * floor-price invariant must allocate identically — if they rounded differently
 * the Guard would report phantom violations worth one paisa.
 */
export function allocateDiscount(
  lineTotals: readonly Minor[],
  totalDiscountMinor: Minor,
): Minor[] {
  const subtotal = lineTotals.reduce((sum, value) => sum + value, 0);
  if (subtotal <= 0 || totalDiscountMinor <= 0) {
    return lineTotals.map(() => 0);
  }

  const exact = lineTotals.map((value) => (value * totalDiscountMinor) / subtotal);
  const floors = exact.map((value) => Math.floor(value));
  let remainder = totalDiscountMinor - floors.reduce((sum, v) => sum + v, 0);

  const order = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);

  const result = [...floors];
  for (const entry of order) {
    if (remainder <= 0) break;
    result[entry.index] = (result[entry.index] ?? 0) + 1;
    remainder -= 1;
  }
  return result;
}
