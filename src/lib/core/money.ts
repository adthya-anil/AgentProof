/**
 * All money in AgentProof is an integer count of minor units (paise for INR).
 *
 * Floating point rupees are banned throughout the codebase: a financial
 * invariant that compares `1399.0000000000002 <= 1399` is worse than no
 * invariant at all. Every amount that crosses a module boundary is a `Minor`.
 */
export type Minor = number;

export type Currency = "INR";

export const MINOR_PER_MAJOR = 100;

export function rupees(major: number): Minor {
  return Math.round(major * MINOR_PER_MAJOR);
}

export function toMajor(minor: Minor): number {
  return minor / MINOR_PER_MAJOR;
}

export function assertMinor(value: number, label: string): Minor {
  if (!Number.isInteger(value)) {
    throw new Error(
      `${label} must be an integer count of minor units, received ${value}`,
    );
  }
  return value;
}

/** Formats paise as `₹1,399.00`, always with two decimals. */
export function formatMinor(minor: Minor, currency: Currency = "INR"): string {
  const symbol = currency === "INR" ? "₹" : "";
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const major = Math.floor(abs / MINOR_PER_MAJOR);
  const fraction = abs % MINOR_PER_MAJOR;
  const grouped = major.toLocaleString("en-IN");
  return `${negative ? "-" : ""}${symbol}${grouped}.${String(fraction).padStart(2, "0")}`;
}

/**
 * Percentage of an amount, rounded half-up to the nearest minor unit.
 *
 * Discounts round *down* in the merchant's favour elsewhere; this helper is
 * the single place rounding happens so the policy engine and the commerce
 * service can never disagree by a paisa.
 */
export function percentOf(minor: Minor, percent: number): Minor {
  return Math.round((minor * percent) / 100);
}

/**
 * Effective discount as a percentage of the pre-discount subtotal.
 *
 * This is the number the discount-cap invariant checks. It is deliberately
 * computed from the two endpoints (subtotal and final total) rather than by
 * summing individual discount lines, because summing is exactly the mistake
 * that lets sequentially-applied discounts stack past the cap.
 */
export function effectiveDiscountPercent(
  subtotal: Minor,
  totalAfterDiscounts: Minor,
): number {
  if (subtotal <= 0) return 0;
  const discounted = subtotal - totalAfterDiscounts;
  return (discounted / subtotal) * 100;
}

/** Rounds a percentage for display/reporting without affecting comparisons. */
export function roundPercent(percent: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(percent * factor) / factor;
}
