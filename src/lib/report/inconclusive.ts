import type { JourneyResult } from "../runner/run.js";

/**
 * Saying why journeys proved nothing, without asserting a cause that did not apply.
 *
 * Every surface used to print one fixed sentence — "the agent ran out of tool budget or
 * declined to proceed, so nothing was verified" — over whatever the count happened to be.
 * On a mapped merchant that was false for half of them: a journey ran to completion, the
 * agent declined nothing, and it was inconclusive purely because `INV-INVENTORY` cannot run
 * against a merchant with no reservations. The footnote blamed the agent for a limitation of
 * the merchant, in the one paragraph a reader turns to for the reason.
 *
 * The three causes call for three different actions — pick a different merchant, fix the
 * scenario, or give the agent more room — so a report that merges them is not shorter, it is
 * wrong. Shared rather than reimplemented per page so the wording cannot drift into a fourth
 * version of the same mistake.
 */
export interface InconclusiveBreakdown {
  /** The invariant the journey targets cannot run against this merchant at all. */
  targetWithheld: number;
  /** The fault the journey depends on was never applied. */
  faultNeverFired: number;
  /** The agent stopped early — exhausted its budget or declined to proceed. */
  agentStopped: number;
  total: number;
}

export function inconclusiveBreakdown(
  journeys: readonly JourneyResult[],
): InconclusiveBreakdown {
  const inconclusive = journeys.filter((j) => j.disposition === "inconclusive");
  const count = (reason: string) =>
    inconclusive.filter((j) => j.inconclusiveReason === reason).length;

  return {
    targetWithheld: count("target_withheld"),
    faultNeverFired: count("fault_never_fired"),
    agentStopped: count("agent_stopped"),
    total: inconclusive.length,
  };
}

/**
 * The breakdown as one sentence, naming only the causes actually present.
 *
 * Returns null when nothing was inconclusive, so a caller cannot render an explanation for
 * an empty set — which is how the fixed sentence survived as long as it did.
 */
export function describeInconclusive(
  breakdown: InconclusiveBreakdown,
): string | null {
  if (breakdown.total === 0) return null;

  const parts: string[] = [];
  if (breakdown.targetWithheld > 0) {
    parts.push(
      `${breakdown.targetWithheld} because the invariant it targets cannot run ` +
        "against this merchant",
    );
  }
  if (breakdown.faultNeverFired > 0) {
    parts.push(
      `${breakdown.faultNeverFired} because the fault it depends on was never applied`,
    );
  }
  if (breakdown.agentStopped > 0) {
    parts.push(
      `${breakdown.agentStopped} because the agent stopped early — out of tool budget ` +
        "or declining to proceed",
    );
  }

  const causes =
    parts.length === 1
      ? parts[0]!
      : `${parts.slice(0, -1).join("; ")}; and ${parts[parts.length - 1]!}`;

  return (
    `${breakdown.total} journey(s) ended inconclusive: ${causes}. ` +
    "Excluded from coverage rather than counted as safe, because they verified nothing."
  );
}
