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
 * The four causes call for four different actions — pick a different merchant, fix the
 * scenario so the agent reaches the trigger, accept that this merchant will not be perturbed,
 * or give the agent more room — so a report that merges them is not shorter, it is wrong. The
 * two fault-absent causes especially: "the agent never reached the tool the fault targets" and
 * "the fault was attempted but this merchant refused it" used to share one value, which blamed
 * the agent for a limitation of the merchant. Shared rather than reimplemented per page so the
 * wording cannot drift into yet another version of the same mistake.
 */
export interface InconclusiveBreakdown {
  /** The merchant could not be reached — refused, unresolvable, 5xx, or timed out. */
  merchantUnreachable: number;
  /** The scenario needed a payment provider that can be told to fail. */
  needsSimulatedProvider: number;
  /**
   * Inconclusive with no cause recorded.
   *
   * Exists so the arithmetic cannot silently break. A journey whose reason this describer
   * does not know would otherwise vanish from the causes while still counting toward the
   * total, and the sentence would claim "3 journeys" then account for one. A reader adding
   * it up finds the report short and has no way to tell which part is wrong.
   */
  unattributed: number;
  /** The invariant the journey targets cannot run against this merchant at all. */
  targetWithheld: number;
  /** The agent never reached the tool the fault targets, so the fault was never attempted. */
  faultTriggerNotReached: number;
  /** The fault was attempted but this merchant refused to be perturbed. */
  faultRejectedByMerchant: number;
  /** The agent stopped early — exhausted its budget or declined to proceed. */
  agentStopped: number;
  /**
   * The agent completed but never presented its target hazard, so the target rule ran
   * against a benign cart and never fired. Nothing of the target was tested.
   */
  targetNotExercised: number;
  total: number;
}

export function inconclusiveBreakdown(
  journeys: readonly JourneyResult[],
): InconclusiveBreakdown {
  const inconclusive = journeys.filter((j) => j.disposition === "inconclusive");
  const count = (reason: string) =>
    inconclusive.filter((j) => j.inconclusiveReason === reason).length;

  const known = {
    merchantUnreachable: count("merchant_unreachable"),
    needsSimulatedProvider: count("fault_needs_simulated_provider"),
    targetWithheld: count("target_withheld"),
    faultTriggerNotReached: count("fault_trigger_not_reached"),
    faultRejectedByMerchant: count("fault_rejected_by_merchant"),
    agentStopped: count("agent_stopped"),
    targetNotExercised: count("target_not_exercised"),
  };

  /**
   * Whatever is left over, counted rather than dropped.
   *
   * Derived by subtraction on purpose: adding a new `InconclusiveReason` and forgetting to
   * teach this function about it is the obvious future mistake, and this makes the omission
   * show up in the sentence instead of quietly unbalancing it.
   */
  const attributed = Object.values(known).reduce((sum, n) => sum + n, 0);

  return {
    ...known,
    unattributed: Math.max(0, inconclusive.length - attributed),
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
  /**
   * First, because it is the only cause that is not about the agent or the scenario. When the
   * merchant was unreachable, nothing else in the sentence explains anything.
   */
  if (breakdown.merchantUnreachable > 0) {
    parts.push(
      `${breakdown.merchantUnreachable} because the merchant could not be reached — ` +
        "refused, unresolvable, or too slow to answer",
    );
  }
  if (breakdown.needsSimulatedProvider > 0) {
    parts.push(
      `${breakdown.needsSimulatedProvider} because the scenario needs a payment provider ` +
        "that can be told to fail, and a real one cannot",
    );
  }
  if (breakdown.targetWithheld > 0) {
    parts.push(
      `${breakdown.targetWithheld} because the invariant it targets cannot run ` +
        "against this merchant",
    );
  }
  if (breakdown.faultTriggerNotReached > 0) {
    parts.push(
      `${breakdown.faultTriggerNotReached} because the fault it depends on was never ` +
        "triggered — the agent did not reach it",
    );
  }
  if (breakdown.faultRejectedByMerchant > 0) {
    parts.push(
      `${breakdown.faultRejectedByMerchant} because the fault it depends on could not be ` +
        "applied to this merchant",
    );
  }
  if (breakdown.targetNotExercised > 0) {
    parts.push(
      `${breakdown.targetNotExercised} because the agent avoided the hazard it targets, ` +
        "so the rule never fired on anything unsafe",
    );
  }
  if (breakdown.agentStopped > 0) {
    parts.push(
      `${breakdown.agentStopped} because the agent stopped early — out of tool budget ` +
        "or declining to proceed",
    );
  }
  // Says so rather than letting the count go missing. An honest "we did not record why" is
  // worth more than a sentence whose numbers do not add up.
  if (breakdown.unattributed > 0) {
    parts.push(`${breakdown.unattributed} for a reason that was not recorded`);
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
