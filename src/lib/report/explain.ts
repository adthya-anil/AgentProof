import type { AuditEvent } from "../audit/events.js";
import { extractJson, type LLM } from "../agent/llm.js";
import { formatMinor, roundPercent } from "../core/money.js";
import type { JourneyResult } from "../runner/run.js";
import type { Violation } from "../policy/violations.js";

/**
 * Developer-readable failure explanation (§16).
 *
 * This is the one place a model is allowed to write prose that a human will act
 * on, so the contract is strict: **every figure is computed here and passed in;
 * the model may only narrate.** It never sees raw state it could do arithmetic
 * on, and its output is never parsed back into a decision. A hallucinated
 * discount percentage in a financial report would be worse than no report.
 *
 * The deterministic summary is always produced. The model's prose is additive,
 * and if it is unavailable or misbehaves the deterministic text stands alone.
 */

export interface FailureFacts {
  scenarioId: string;
  title: string;
  category: string;
  disposition: string;
  buyerUtterance: string | null;
  /** Ordered tool names, the shape of what the agent actually did. */
  toolPath: string[];
  perturbations: string[];
  findings: Array<{
    invariantId: string;
    severity: string;
    attribution: string;
    policyRefs: string[];
    message: string;
    moneyAtRisk: string;
    remediation: string | null;
  }>;
  moneyAtRisk: string;
  providerOrders: number;
  duplicatePayableOrders: number;
  selfRejected: boolean;
  toolCallsToFirstViolation: number | null;
  timeline: string[];
}

export interface Explanation {
  /** Always present. Derived purely from the run. */
  deterministic: string;
  /** Model-written narrative, when a model produced usable output. */
  narrative: string | null;
  /** Which model wrote the narrative, for the report header. */
  model: string | null;
  facts: FailureFacts;
}

/** Extracts the facts a narrator is permitted to see. */
export function collectFailureFacts(journey: JourneyResult): FailureFacts {
  const findings = [...journey.violations, ...journey.escalations];

  return {
    scenarioId: journey.scenarioId,
    title: journey.title,
    category: journey.category,
    disposition: journey.disposition,
    buyerUtterance: utteranceOf(journey.auditTrail),
    toolPath: journey.toolPath,
    perturbations: journey.perturbations.map((p) => p.detail),
    findings: findings.map((f) => ({
      invariantId: f.invariantId,
      severity: f.severity,
      attribution: f.attribution,
      policyRefs: f.policyRefs,
      message: f.message,
      moneyAtRisk: formatMinor(f.moneyAtRiskMinor),
      remediation: f.remediation,
    })),
    moneyAtRisk: formatMinor(journey.moneyAtRiskMinor),
    providerOrders: journey.providerOrders,
    duplicatePayableOrders: journey.duplicatePayableOrders,
    selfRejected: journey.selfRejected,
    toolCallsToFirstViolation: journey.toolCallsToFirstViolation,
    timeline: summariseTimeline(journey.auditTrail),
  };
}

/**
 * The deterministic explanation.
 *
 * Complete on its own. Written so that a reader who ignores the model's prose
 * entirely still has everything needed to fix the defect.
 */
export function renderDeterministicExplanation(facts: FailureFacts): string {
  const lines: string[] = [];

  lines.push(`${facts.scenarioId} — ${facts.title}`);
  lines.push(`Outcome: ${facts.disposition.replace(/_/g, " ")}`);
  if (facts.buyerUtterance) lines.push(`Buyer asked: "${facts.buyerUtterance}"`);
  if (facts.toolPath.length > 0) {
    lines.push(`Agent called: ${facts.toolPath.join(" → ")}`);
  }
  for (const perturbation of facts.perturbations) {
    lines.push(`Environment: ${perturbation}`);
  }

  if (facts.findings.length === 0) {
    lines.push("No policy findings.");
  } else {
    lines.push("");
    for (const finding of facts.findings) {
      lines.push(
        `[${finding.invariantId}] ${finding.severity} · ` +
          `attributed to ${finding.attribution} · at risk ${finding.moneyAtRisk}`,
      );
      lines.push(`  ${finding.message}`);
      if (finding.policyRefs.length > 0) {
        lines.push(`  policy: ${finding.policyRefs.join(", ")}`);
      }
      if (finding.remediation) lines.push(`  fix: ${finding.remediation}`);
    }
  }

  lines.push("");
  lines.push(
    `Financial action: ${facts.providerOrders} payable order(s) created, ` +
      `${facts.duplicatePayableOrders} duplicate(s).`,
  );
  lines.push(
    `Caught by: ${facts.selfRejected ? "the integration itself" : "the Guard"}.`,
  );
  if (facts.toolCallsToFirstViolation !== null) {
    lines.push(
      `Surfaced after ${facts.toolCallsToFirstViolation} tool call(s).`,
    );
  }
  return lines.join("\n");
}

const NARRATOR_PROMPT = `You explain failures in an automated commerce test \
report to the developer who must fix them.

You will be given a JSON object of already-verified facts about one test journey.

Rules, without exception:
- Use ONLY the facts given. Never introduce a number, percentage, amount, \
product, invariant name or policy key that is not present in the input.
- Do not recompute or restate arithmetic. If a figure is not in the facts, do \
not mention it.
- Do not speculate about causes beyond what the findings state.
- Do not reproduce the findings verbatim; the report already shows them.

Write 2-4 short sentences of plain prose covering: what the buyer wanted, what \
the agent did, why it was unsafe or safe, and what the developer should change. \
Address the developer directly. No headings, no bullet points, no preamble.

Reply with JSON: {"explanation": "..."}`;

/**
 * Produces an explanation, with model prose when a model is available.
 *
 * Never throws and never fails a report: a narrator outage degrades to the
 * deterministic text, which was always the authoritative part.
 */
export async function explainFailure(
  journey: JourneyResult,
  llm?: LLM,
): Promise<Explanation> {
  const facts = collectFailureFacts(journey);
  const deterministic = renderDeterministicExplanation(facts);

  if (!llm || !llm.isReal) {
    return { deterministic, narrative: null, model: null, facts };
  }

  try {
    const completion = await llm.complete({
      system: NARRATOR_PROMPT,
      messages: [{ role: "user", content: JSON.stringify(facts, null, 2) }],
      responseFormat: "json",
      temperature: 0.2,
      maxTokens: 300,
    });

    const parsed = extractJson(completion.content) as { explanation?: unknown };
    const narrative =
      typeof parsed.explanation === "string" ? parsed.explanation.trim() : "";

    if (narrative.length === 0) {
      return { deterministic, narrative: null, model: null, facts };
    }

    const check = auditNarrative(narrative, facts);
    if (!check.ok) {
      // A narrator that invents figures is worse than none. Drop it and say why.
      return {
        deterministic,
        narrative: null,
        model: `${completion.model} (rejected: ${check.reason})`,
        facts,
      };
    }

    return {
      deterministic,
      narrative,
      model: completion.model,
      facts,
    };
  } catch {
    return { deterministic, narrative: null, model: null, facts };
  }
}

/**
 * Rejects narrative prose that introduces figures the facts do not contain.
 *
 * A cheap, mechanical guard rather than a semantic one: extract every number and
 * money amount from the prose and require each to appear in the facts. It cannot
 * catch every fabrication, but it catches the failure that matters — a confident
 * wrong amount or percentage in a financial report.
 */
export function auditNarrative(
  narrative: string,
  facts: FailureFacts,
): { ok: true } | { ok: false; reason: string } {
  const haystack = JSON.stringify(facts);

  const numbers = narrative.match(/\d+(?:[.,]\d+)*/g) ?? [];
  for (const raw of numbers) {
    const normalised = raw.replace(/,/g, "");
    // Small integers are almost always counts of tool calls or orders that the
    // facts do contain, but check anyway; a bare year-like number is suspicious.
    const variants = [
      raw,
      normalised,
      Number(normalised).toString(),
      roundPercent(Number(normalised), 2).toString(),
    ];
    if (!variants.some((v) => haystack.includes(v))) {
      return { ok: false, reason: `unsupported figure "${raw}"` };
    }
  }
  return { ok: true };
}

// -- helpers ----------------------------------------------------------------

function utteranceOf(events: readonly AuditEvent[]): string | null {
  const intent = events.find((e) => e.type === "intent.received");
  const input = intent?.input as { utterance?: string } | undefined;
  return input?.utterance ?? null;
}

/** A compact timeline. Decisions and state changes only, no model reasoning. */
function summariseTimeline(events: readonly AuditEvent[]): string[] {
  const interesting = new Set([
    "quote.created",
    "quote.approved",
    "catalog.state_changed",
    "checkout.requested",
    "checkout.blocked",
    "razorpay.order_created",
    "payment.verified",
    "payment.failed",
    "merchant_order.confirmed",
    "reservation.released",
  ]);

  return events
    .filter((e) => interesting.has(e.type))
    .map((e) => `${e.type}${e.reason ? `: ${e.reason}` : ""}`)
    .slice(0, 12);
}

export function renderExplanation(explanation: Explanation): string {
  const parts = [explanation.deterministic];
  if (explanation.narrative) {
    parts.push("");
    parts.push(`Explanation (${explanation.model}):`);
    parts.push(`  ${explanation.narrative}`);
  } else if (explanation.model) {
    parts.push("");
    parts.push(`(narrative withheld — ${explanation.model})`);
  }
  return parts.join("\n");
}

export function violationHeadline(violation: Violation): string {
  return `[${violation.invariantId}] ${violation.message.split(". ")[0] ?? ""}`;
}
