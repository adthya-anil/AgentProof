import { formatMinor, roundPercent } from "../core/money.js";
import type { JourneyResult, SuiteResult } from "../runner/run.js";
import { SEVERITY_RANK } from "../policy/violations.js";

/**
 * Renders the preflight readiness report (§9).
 *
 * Deliberately worded as a *readiness report*, never a certification. No finite
 * suite can prove the absence of defects, which is also why the same policy
 * engine stays active at runtime.
 */
export interface ReportProvenance {
  /** Model that generated the semantic scenarios. */
  generatorModel: string;
  generatorIsReal: boolean;
  regressionCount: number;
  generatedCount: number;
}

export function renderPreflightReport(
  suite: SuiteResult,
  provenance?: ReportProvenance,
): string {
  const lines: string[] = [];
  const defectJourneys = suite.journeys.filter(
    (j) => j.disposition === "unsafe_violation",
  );

  lines.push("AgentProof Preflight Report");
  lines.push("");
  lines.push("Integration: HamperHub Agent Checkout");
  lines.push(`Policy version: ${suite.policyVersion}`);
  lines.push(
    `Active seeded defects: ${
      suite.mutations.length > 0 ? suite.mutations.join(", ") : "none"
    }`,
  );
  lines.push(`Journeys executed: ${suite.journeys.length}`);
  if (provenance) {
    lines.push(
      `  ${provenance.regressionCount} fixed regression + ` +
        `${provenance.generatedCount} AI-generated ` +
        `(${provenance.generatorModel}` +
        `${provenance.generatorIsReal ? "" : ", deterministic"})`,
    );
  }
  lines.push("");
  lines.push(`Passed:                   ${pad(suite.passed)}`);
  lines.push(`Safely rejected:          ${pad(suite.safelyRejected)}`);
  lines.push(`Escalated for approval:   ${pad(suite.escalated)}`);
  lines.push(`Unsafe violations:        ${pad(suite.unsafeViolations)}`);
  if (suite.errored > 0) {
    lines.push(`Errored:                  ${pad(suite.errored)}`);
  }
  lines.push(`Money-critical escapes:   ${pad(suite.moneyCriticalEscapes)}`);
  lines.push("");

  if (defectJourneys.length > 0) {
    lines.push("Critical violations:");
    const seen = new Set<string>();
    for (const journey of defectJourneys) {
      const ordered = [...journey.integrationDefects].sort(
        (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
      );
      for (const violation of ordered) {
        const key = `${violation.invariantId}:${violation.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(`• [${violation.invariantId}] ${headline(violation.message)}`);
        lines.push(
          `    scenario ${journey.scenarioId} · severity ${violation.severity} · ` +
            `at risk ${formatMinor(violation.moneyAtRiskMinor)}`,
        );
        if (violation.remediation) {
          lines.push(`    fix: ${violation.remediation}`);
        }
      }
    }
    lines.push("");
  }

  const escalated = suite.journeys.filter((j) => j.disposition === "escalated");
  if (escalated.length > 0) {
    lines.push("Escalated (policy declined to decide automatically):");
    for (const journey of escalated) {
      for (const item of journey.escalations) {
        lines.push(`• [${item.invariantId}] ${headline(item.message)}`);
      }
    }
    lines.push("");
  }

  const byCategory = new Map<string, { total: number; unsafe: number }>();
  for (const journey of suite.journeys) {
    const entry = byCategory.get(journey.category) ?? { total: 0, unsafe: 0 };
    entry.total += 1;
    if (journey.disposition === "unsafe_violation") entry.unsafe += 1;
    byCategory.set(journey.category, entry);
  }
  lines.push("Coverage by scenario category:");
  for (const [category, entry] of [...byCategory.entries()].sort()) {
    lines.push(
      `  ${category.padEnd(20)} ${String(entry.total).padStart(2)} journeys, ` +
        `${entry.unsafe} unsafe`,
    );
  }
  lines.push("");

  lines.push("Journeys:");
  for (const journey of suite.journeys) {
    lines.push(
      `  ${symbol(journey)} ${journey.scenarioId.padEnd(28)} ` +
        `${journey.disposition.padEnd(17)} ${journey.note.slice(0, 60)}`,
    );
  }
  lines.push("");

  lines.push(`Total money at risk (prevented): ${formatMinor(suite.moneyAtRiskMinor)}`);
  lines.push(`Audit chain: ${suite.auditChainOk ? "verified" : "BROKEN"}`);
  lines.push(`Duration: ${suite.durationMs}ms`);
  lines.push("");
  lines.push("Readiness status:");
  lines.push(suite.readiness);

  return lines.join("\n");
}

/** Detection metrics for the mutation evaluation (§17). */
export interface MutationScore {
  mutation: string;
  expectedInvariant: string;
  detected: boolean;
  detectedBy: string[];
  escapes: number;
}

export function renderMutationScorecard(
  scores: readonly MutationScore[],
  falsePositives: { flagged: number; total: number },
): string {
  const detected = scores.filter((s) => s.detected).length;
  const escapes = scores.reduce((sum, s) => sum + s.escapes, 0);
  const recall = scores.length === 0 ? 0 : (detected / scores.length) * 100;
  const fpRate =
    falsePositives.total === 0
      ? 0
      : (falsePositives.flagged / falsePositives.total) * 100;

  const lines: string[] = [];
  lines.push("Mutation evaluation");
  lines.push("");
  for (const score of scores) {
    lines.push(
      `  ${score.detected ? "✓" : "✗"} ${score.mutation.padEnd(30)} ` +
        `${score.expectedInvariant.padEnd(22)} ` +
        `${score.detected ? `fired: ${score.detectedBy.join(", ")}` : "NOT DETECTED"}`,
    );
  }
  lines.push("");
  lines.push(
    `Defect detection recall: ${detected}/${scores.length} (${roundPercent(recall, 1)}%)`,
  );
  lines.push(
    `False-positive rate: ${falsePositives.flagged}/${falsePositives.total} ` +
      `safe journeys flagged (${roundPercent(fpRate, 1)}%)`,
  );
  lines.push(`Unsafe money actions that escaped the Guard: ${escapes}`);
  lines.push("");
  lines.push(
    "Each mutant is evaluated in isolation, which is standard mutation-testing",
  );
  lines.push(
    "practice: with several defects active at once an upstream block can mask a",
  );
  lines.push("downstream one, understating recall.");
  return lines.join("\n");
}

function symbol(journey: JourneyResult): string {
  switch (journey.disposition) {
    case "passed":
      return "✓";
    case "safely_rejected":
      return "•";
    case "escalated":
      return "?";
    case "unsafe_violation":
      return "✗";
    case "errored":
      return "!";
  }
}

function headline(message: string): string {
  const firstSentence = message.split(". ")[0] ?? message;
  return firstSentence.length > 150
    ? `${firstSentence.slice(0, 150)}…`
    : firstSentence;
}

function pad(value: number): string {
  return String(value).padStart(2, " ");
}
