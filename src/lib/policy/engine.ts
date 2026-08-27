import type { GuardDecision, ViolationSeverity } from "../audit/events.js";
import type { Minor } from "../core/money.js";
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
  skippedCount: number;
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

    for (const invariant of applicable) {
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
        skippedCount += 1;
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
      };

      if (outcome.status === "escalation") escalations.push(record);
      else violations.push(record);
    }

    const decision: GuardDecision =
      violations.length > 0
        ? "block"
        : escalations.length > 0
          ? "escalate"
          : applicable.length === 0
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
      maxSeverity: highestSeverity([...violations, ...escalations]),
      moneyAtRiskMinor,
      reason: summarize(decision, violations, escalations, applicable.length),
    };
  }
}

function summarize(
  decision: GuardDecision,
  violations: readonly Violation[],
  escalations: readonly Violation[],
  evaluated: number,
): string {
  if (decision === "allow") {
    return `${evaluated} invariants evaluated, no violations`;
  }
  if (decision === "not_applicable") {
    return "No invariants apply at this checkpoint";
  }
  if (decision === "escalate") {
    return `Requires human approval: ${escalations
      .map((e) => e.invariantId)
      .join(", ")}`;
  }
  return `Blocked by ${violations.map((v) => v.invariantId).join(", ")}`;
}

export const defaultPolicyEngine = new PolicyEngine();
