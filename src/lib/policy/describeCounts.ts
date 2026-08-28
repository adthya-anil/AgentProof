/**
 * Describes a policy evaluation's rule counts in words.
 *
 * Split out of the console so it can be tested, because the version it replaces was
 * actively misleading. `Guard: 6/7 rules passed` invites exactly one reading — that
 * one rule failed — when in fact `evaluated` counts every *applicable* rule and the
 * seventh had been skipped: a payment-state rule has nothing to say at quote time.
 *
 * The result was a trace implying a finding on the same screen as "Every invariant
 * that applied was satisfied". Two statements about the same evaluation, disagreeing.
 *
 * A skipped rule matters and is worth reporting — it is how coverage is measured —
 * but it is not a failure, and nobody should have to reverse-engineer which one a
 * fraction meant.
 */
export interface RuleCounts {
  evaluated?: unknown;
  passed?: unknown;
  skipped?: unknown;
  /** Rules withheld for missing merchant capabilities. Never "not applicable". */
  withheld?: unknown;
}

/**
 * Names the rules that did not apply, for the row's detail line.
 *
 * "One rule did not apply" immediately invites "which one?", and that question is
 * how coverage gets judged: `INV-PRODUCT-SAFETY` skipping because no allergens were
 * declared is correct, while the same rule skipping for an allergic buyer would be a
 * hole. A count alone cannot tell those apart.
 */
export function describeSkipped(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const names = value.filter((v): v is string => typeof v === "string");
  if (names.length === 0) return undefined;
  return `not applicable here: ${names.join(", ")}`;
}

/**
 * Names the rules that could not run against this merchant at all.
 *
 * Deliberately worded differently from `describeSkipped`. "Not applicable here" is a
 * rule waiting for a later checkpoint; this is a rule that will never run, because the
 * merchant cannot supply what it compares. A reader who cannot tell those apart cannot
 * tell full coverage from a third of it.
 */
export function describeWithheld(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const names = value
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry === "object" && "invariant" in entry) {
        return String((entry as { invariant: unknown }).invariant);
      }
      return null;
    })
    .filter((name): name is string => Boolean(name));
  if (names.length === 0) return undefined;
  return `could not run — merchant data missing: ${names.join(", ")}`;
}

export function describeRuleCounts(counts: RuleCounts): string {
  const passed = asCount(counts.passed);
  const skipped = asCount(counts.skipped);
  const evaluated = asCount(counts.evaluated);
  const withheld = asCount(counts.withheld);

  // Anything unaccounted for genuinely did not pass. Say so rather than let it
  // hide inside a denominator.
  const unaccounted = Math.max(0, evaluated - passed - skipped - withheld);

  // The passed count is always stated, including when it is zero. "3 not
  // applicable" alone leaves a reader to infer how many rules actually ruled on
  // this step, and inference is what the old fraction already got wrong.
  const parts: string[] = [`${passed} passed`];
  if (skipped > 0) parts.push(`${skipped} not applicable`);
  // Withheld rules are called out in their own words. Folding them into "not
  // applicable" would turn a permanent coverage hole into a routine one.
  if (withheld > 0) parts.push(`${withheld} could not run`);
  if (unaccounted > 0) parts.push(`${unaccounted} unresolved`);

  return parts.join(", ");
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}


/**
 * Describes promotions the merchant refused.
 *
 * A quote reading "discounts ₹0" after the agent asked for FESTIVE10 is
 * indistinguishable from a promo code being silently swallowed. Naming the code and
 * the reason is the difference between a merchant correctly enforcing a 5% cap and
 * one quietly dropping requests — and only one of those is a defect.
 *
 * Returns a leading separator so it can be appended to an existing detail line, or
 * undefined when every requested promotion applied.
 */
export function describeRejectedPromos(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;

  const described = value
    .filter(
      (entry): entry is { code: unknown; reason?: unknown } =>
        typeof entry === "object" && entry !== null && "code" in entry,
    )
    .map((entry) => {
      const code = String(entry.code);
      const reason =
        typeof entry.reason === "string" && entry.reason.length > 0
          ? entry.reason
          : "refused";
      return `${code} (${reason})`;
    });

  if (described.length === 0) return undefined;
  return ` — refused: ${described.join("; ")}`;
}
