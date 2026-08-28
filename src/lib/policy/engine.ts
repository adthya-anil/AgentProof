import type { GuardDecision, ViolationSeverity } from "../audit/events.js";
import type { Minor } from "../core/money.js";
import { type Capability, describeCapability } from "./capabilities.js";
import { invariantsFor } from "./invariants/index.js";
import type {
  Checkpoint,
  EvaluationContext,
  Invariant,
  InvariantOutcome,
} from "./invariants/types.js";
import { type Violation, highestSeverity, violationId } from "./violations.js";

export interface InvariantResult {
  invariantId: string;
  title: string;
  status: InvariantOutcome["status"];
  detail: string | null;
  /** Set when the rule was withheld for want of merchant data, not skipped. */
  missingCapabilities?: readonly Capability[];
}

export interface PolicyEvaluation {
  checkpoint: Checkpoint;
  policyVersion: string;
  decision: GuardDecision;
  /** Genuine policy breaches — an unsafe integration. */
  violations: Violation[];
  /** Cases policy declines to auto-approve. Safe, not defects. */
  escalations: Violation[];
  results: InvariantResult[];
  evaluatedCount: number;
  passedCount: number;
  /** Rules with nothing to say at this checkpoint. Coverage working normally. */
  skippedCount: number;
  /**
   * Rules that could not run because the merchant cannot supply their inputs.
   *
   * Counted apart from `skippedCount` because the two mean opposite things about
   * coverage: one rule is waiting for a later checkpoint, the other will never run
   * against this merchant at all. A single "skipped" number would read as the
   * harmless case.
   */
  unsupportedCount: number;
  /** Which rules were withheld, and what each one needed. */
  capabilityGaps: Array<{ invariantId: string; missing: readonly Capability[] }>;
  maxSeverity: ViolationSeverity | null;
  moneyAtRiskMinor: Minor;
  /** One-line summary suitable for an audit entry. */
  reason: string;
}

/**
 * Runs every invariant applicable to a checkpoint and reduces the outcomes to a
 * single decision.
 *
 * All applicable invariants are evaluated rather than short-circuiting on the
 * first failure: a preflight report is far more useful when it lists every rule
 * a journey broke, and detection recall depends on not stopping early.
 */
export class PolicyEngine {
  constructor(private readonly invariants?: readonly Invariant[]) {}

  evaluate(ctx: EvaluationContext): PolicyEvaluation {
    const applicable =
      this.invariants?.filter((inv) => inv.appliesAt.includes(ctx.checkpoint)) ??
      invariantsFor(ctx.checkpoint);

    const results: InvariantResult[] = [];
    const violations: Violation[] = [];
    const escalations: Violation[] = [];
    let passedCount = 0;
    let skippedCount = 0;
    let unsupportedCount = 0;
    const capabilityGaps: Array<{
      invariantId: string;
      missing: readonly Capability[];
    }> = [];

    for (const invariant of applicable) {
      /**
       * Withhold the rule before running it, rather than letting it read undefined.
       *
       * Checked here instead of inside each invariant for two reasons: an invariant
       * body cannot be trusted to remember, and a rule that compares two absent
       * fields will find them equal and pass. That pass would then be counted as
       * coverage, which is a false statement about money made by omission.
       */
      const missing = ctx.capabilities.missing(invariant.requires ?? []);
      if (missing.length > 0) {
        unsupportedCount += 1;
        capabilityGaps.push({ invariantId: invariant.id, missing });
        results.push({
          invariantId: invariant.id,
          title: invariant.title,
          status: "skipped",
          detail:
            `cannot run against this merchant: ` +
            missing.map((c) => `${c} (${describeCapability(c)})`).join("; "),
          missingCapabilities: missing,
        });
        continue;
      }

      let outcome: InvariantOutcome;
      try {
        outcome = invariant.evaluate(ctx);
      } catch (error) {
        // An invariant that throws is itself a finding: never silently pass.
        outcome = {
          status: "violation",
          message:
            `Invariant ${invariant.id} failed to evaluate: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          severity: "high",
          attribution: "integration",
        };
      }

      results.push({
        invariantId: invariant.id,
        title: invariant.title,
        status: outcome.status,
        detail:
          outcome.status === "pass"
            ? (outcome.detail ?? null)
            : outcome.status === "skipped"
              ? outcome.detail
              : outcome.message,
      });

      if (outcome.status === "pass") {
        passedCount += 1;
        continue;
      }
      if (outcome.status === "skipped") {
        // An invariant may also decide for itself that it lacks what it needs.
        if (outcome.reason === "missing_capability") {
          unsupportedCount += 1;
          if (outcome.missing?.length) {
            capabilityGaps.push({
              invariantId: invariant.id,
              missing: outcome.missing,
            });
          }
        } else {
          skippedCount += 1;
        }
        continue;
      }

      const record: Violation = {
        id: violationId({
          invariantId: invariant.id,
          checkpoint: ctx.checkpoint,
          intentId: ctx.intent.id,
          message: outcome.message,
        }),
        invariantId: invariant.id,
        title: invariant.title,
        severity: outcome.severity ?? invariant.severity,
        checkpoint: ctx.checkpoint,
        policyRefs: invariant.policyRefs,
        attribution: outcome.attribution ?? invariant.attribution,
        message: outcome.message,
        observed: outcome.observed ?? {},
        expected: outcome.expected ?? {},
        moneyAtRiskMinor: outcome.moneyAtRiskMinor ?? 0,
        remediation: outcome.remediation ?? null,
        runId: ctx.intent.runId,
        intentId: ctx.intent.id,
        quoteId: ctx.quote?.id ?? null,
        at: ctx.clock.now(),
        detectedAtMs: Date.now(),
      };

      if (outcome.status === "escalation") escalations.push(record);
      else violations.push(record);
    }

    /**
     * A checkpoint where every applicable rule was withheld is not an approval.
     *
     * `allow` here would mean "nothing objected", which is technically true and
     * practically a lie: nothing ran. `not_applicable` is what the caller already
     * treats as "no opinion", and it is the honest answer when the merchant supplied
     * none of the inputs.
     */
    const ruledOnCount = applicable.length - unsupportedCount;
    const decision: GuardDecision =
      violations.length > 0
        ? "block"
        : escalations.length > 0
          ? "escalate"
          : ruledOnCount === 0
            ? "not_applicable"
            : "allow";

    const moneyAtRiskMinor = [...violations, ...escalations].reduce(
      (sum, item) => sum + item.moneyAtRiskMinor,
      0,
    );

    return {
      checkpoint: ctx.checkpoint,
      policyVersion: ctx.policyVersion,
      decision,
      violations,
      escalations,
      results,
      evaluatedCount: applicable.length,
      passedCount,
      skippedCount,
      unsupportedCount,
      capabilityGaps,
      maxSeverity: highestSeverity([...violations, ...escalations]),
      moneyAtRiskMinor,
      reason: summarize(
        decision,
        violations,
        escalations,
        applicable.length,
        unsupportedCount,
      ),
    };
  }
}

function summarize(
  decision: GuardDecision,
  violations: readonly Violation[],
  escalations: readonly Violation[],
  evaluated: number,
  unsupported: number,
): string {
  if (decision === "allow") {
    // Naming the withheld rules inside the approval line, because this is the
    // sentence that goes into the audit trail and "no violations" alone would
    // overstate what was checked.
    const caveat =
      unsupported > 0
        ? `, ${unsupported} withheld for missing merchant data`
        : "";
    return `${evaluated} invariants evaluated, no violations${caveat}`;
  }
  if (decision === "not_applicable") {
    return unsupported > 0
      ? `No invariants could run: ${unsupported} withheld for missing merchant data`
      : "No invariants apply at this checkpoint";
  }
  if (decision === "escalate") {
    return `Requires human approval: ${escalations
      .map((e) => e.invariantId)
      .join(", ")}`;
  }
  return `Blocked by ${violations.map((v) => v.invariantId).join(", ")}`;
}

export const defaultPolicyEngine = new PolicyEngine();
