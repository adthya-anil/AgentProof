import { ALL_INVARIANTS } from "../policy/invariants/index.js";
import type { Minor } from "../core/money.js";
import type { JourneyResult } from "../runner/run.js";

/**
 * The §17 evaluation metrics that are derived rather than counted.
 *
 * Coverage numbers exist to stop a reader over-reading a clean report: "0 unsafe
 * violations" means much less if only three of twelve rules were ever exercised,
 * or if every journey walked the same tool path. Publishing coverage alongside
 * the verdict is what makes the verdict interpretable.
 */
export interface SuiteMetrics {
  scenariosExecuted: number;

  /** Invariants that actually evaluated (not skipped) at least once. */
  policyRulesExercised: number;
  policyRulesTotal: number;
  policyRulesExercisedPercent: number;
  exercisedInvariantIds: string[];
  unexercisedInvariantIds: string[];

  /** Distinct ordered tool-call sequences observed. */
  toolPathsCovered: number;
  toolPaths: string[];

  /** Critical-severity findings attributed to the integration under test. */
  criticalViolations: number;

  /**
   * How quickly a violation surfaced. Real elapsed time, and tool calls, because
   * wall-clock is tiny here and tool calls are the more meaningful unit.
   */
  medianMsToFirstViolation: number | null;
  medianToolCallsToFirstViolation: number | null;

  /** Second payable orders the Guard stopped for the same buyer intent. */
  duplicatePaymentAttemptsPrevented: number;

  /** Payable orders beyond the first that actually got through. Must be zero. */
  unsafeMoneyActionsEscaped: number;

  moneyAtRiskMinor: Minor;
}

export function computeSuiteMetrics(
  journeys: readonly JourneyResult[],
): SuiteMetrics {
  const exercised = new Set<string>();
  for (const journey of journeys) {
    for (const id of journey.exercisedInvariants) exercised.add(id);
  }
  const allIds = ALL_INVARIANTS.map((inv) => inv.id);

  const toolPaths = new Set<string>();
  for (const journey of journeys) {
    if (journey.toolPath.length > 0) toolPaths.add(journey.toolPath.join(" → "));
  }

  const msSamples = journeys
    .map((j) => j.msToFirstViolation)
    .filter((v): v is number => v !== null);
  const callSamples = journeys
    .map((j) => j.toolCallsToFirstViolation)
    .filter((v): v is number => v !== null);

  // Counted over integration defects only, so this cannot contradict the
  // headline "unsafe violations" figure. A critical verdict against the agent or
  // the environment is the Guard working, not a merchant bug.
  const criticalViolations = journeys.reduce(
    (sum, j) =>
      sum + j.integrationDefects.filter((v) => v.severity === "critical").length,
    0,
  );

  return {
    scenariosExecuted: journeys.length,

    policyRulesExercised: exercised.size,
    policyRulesTotal: allIds.length,
    policyRulesExercisedPercent:
      allIds.length === 0 ? 0 : (exercised.size / allIds.length) * 100,
    exercisedInvariantIds: allIds.filter((id) => exercised.has(id)),
    unexercisedInvariantIds: allIds.filter((id) => !exercised.has(id)),

    toolPathsCovered: toolPaths.size,
    toolPaths: [...toolPaths].sort(),

    criticalViolations,

    medianMsToFirstViolation: median(msSamples),
    medianToolCallsToFirstViolation: median(callSamples),

    duplicatePaymentAttemptsPrevented: journeys.reduce(
      (sum, j) => sum + j.duplicatePaymentsPrevented,
      0,
    ),
    unsafeMoneyActionsEscaped: journeys.reduce(
      (sum, j) => sum + j.duplicatePayableOrders,
      0,
    ),
    moneyAtRiskMinor: journeys.reduce((sum, j) => sum + j.moneyAtRiskMinor, 0),
  };
}

/** Median of a numeric sample. Null for an empty sample, never 0. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export function renderMetrics(metrics: SuiteMetrics): string {
  const lines: string[] = [];
  lines.push("Coverage and detection metrics");
  lines.push("");
  lines.push(`  Scenarios executed:            ${metrics.scenariosExecuted}`);
  lines.push(
    `  Policy rules exercised:        ${metrics.policyRulesExercised}/${metrics.policyRulesTotal}` +
      ` (${Math.round(metrics.policyRulesExercisedPercent)}%)`,
  );
  if (metrics.unexercisedInvariantIds.length > 0) {
    lines.push(
      `    never exercised:             ${metrics.unexercisedInvariantIds.join(", ")}`,
    );
  }
  lines.push(`  Distinct tool paths covered:   ${metrics.toolPathsCovered}`);
  lines.push(
    `  Critical integration defects:  ${metrics.criticalViolations}`,
  );
  lines.push(
    `  Median time to 1st violation:  ${
      metrics.medianMsToFirstViolation === null
        ? "n/a (no violations)"
        : `${metrics.medianMsToFirstViolation}ms`
    }`,
  );
  lines.push(
    `  Median tool calls to 1st:      ${
      metrics.medianToolCallsToFirstViolation === null
        ? "n/a"
        : metrics.medianToolCallsToFirstViolation
    }`,
  );
  lines.push(
    `  Duplicate payments prevented:  ${metrics.duplicatePaymentAttemptsPrevented}`,
  );
  lines.push(
    `  Unsafe money actions escaped:  ${metrics.unsafeMoneyActionsEscaped}`,
  );
  return lines.join("\n");
}
