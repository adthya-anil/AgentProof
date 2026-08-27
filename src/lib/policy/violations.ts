import type { ViolationSeverity } from "../audit/events.js";
import { stableHash } from "../core/ids.js";
import type { Minor } from "../core/money.js";
import type { Attribution, Checkpoint } from "./invariants/types.js";

export interface Violation {
  id: string;
  invariantId: string;
  title: string;
  severity: ViolationSeverity;
  checkpoint: Checkpoint;
  policyRefs: string[];
  /** Who is responsible. Only `integration` findings indicate a merchant bug. */
  attribution: Attribution;
  /** Concrete, numeric, developer-readable. Never model reasoning. */
  message: string;
  observed: Record<string, unknown>;
  expected: Record<string, unknown>;
  moneyAtRiskMinor: Minor;
  remediation: string | null;
  runId: string;
  intentId: string;
  quoteId: string | null;
  /** Simulated time, from the injected clock. Used in the replay. */
  at: Date;
  /**
   * Real wall-clock milliseconds when this was detected.
   *
   * Distinct from `at` because the engine runs on a ManualClock that scenarios
   * advance deliberately. Simulated time answers "when in the journey"; this
   * answers "how quickly did AgentProof find it", which is the §17 metric.
   */
  detectedAtMs: number;
}

/**
 * Violation ids are content-derived rather than sequential, so the same defect
 * found in two runs carries the same id. That is what lets the report say
 * "still failing" vs "newly failing" after a fix-and-rerun.
 */
export function violationId(input: {
  invariantId: string;
  checkpoint: Checkpoint;
  intentId: string;
  message: string;
}): string {
  return `vio_${stableHash(input).slice(0, 12)}`;
}

export const SEVERITY_RANK: Record<ViolationSeverity, number> = {
  critical: 3,
  high: 2,
  medium: 1,
  info: 0,
};

export function highestSeverity(
  violations: readonly Violation[],
): ViolationSeverity | null {
  let best: ViolationSeverity | null = null;
  for (const item of violations) {
    if (!best || SEVERITY_RANK[item.severity] > SEVERITY_RANK[best]) {
      best = item.severity;
    }
  }
  return best;
}

export function isMoneyCritical(violation: Violation): boolean {
  return violation.severity === "critical" || violation.moneyAtRiskMinor > 0;
}

/** Findings that indicate a defect in the integration under test. */
export function integrationDefects(
  violations: readonly Violation[],
): Violation[] {
  return violations.filter((v) => v.attribution === "integration");
}
