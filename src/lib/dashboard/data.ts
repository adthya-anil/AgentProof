import { llmFromEnv } from "../agent/factory.js";
import { ScriptedLLM } from "../agent/scripted.js";
import type { LLM } from "../agent/llm.js";
import { describeAdapter, selectPaymentAdapter } from "../payments/factory.js";
import { IdFactory } from "../core/ids.js";
import { ManualClock } from "../core/clock.js";
import {
  MUTATION_IDS,
  type MutationId,
  MutationSet,
  describeMutation,
} from "../hamperhub/mutations.js";
import { loadPolicyFromFile } from "../policy/load.js";
import type { Policy } from "../policy/schema.js";
import { type JourneyResult, type SuiteResult, runScenario, runSuite } from "../runner/run.js";
import { assembleSuite } from "../scenarios/index.js";
import type { Scenario } from "../scenarios/types.js";

/**
 * Server-side data layer for the dashboard.
 *
 * Preflight runs are deterministic and take tens of milliseconds, so pages
 * execute a real run on request rather than reading a stored artefact. That
 * keeps the dashboard honest — what it shows is a run that just happened, not a
 * cached summary that may no longer reflect the code.
 */

export type IntegrationVariant = "vulnerable" | "fixed";

/**
 * Which model the *report* pages use.
 *
 * Deliberately the scripted one by default, even when a real model is
 * configured. Two reasons:
 *
 *  1. A readiness report should be reproducible. Reviewers compare runs, and
 *     numbers that shift on every refresh are not comparable.
 *  2. A real model driving 9 generated journeys takes minutes, because each
 *     journey is a full multi-turn tool-calling conversation. A web page that
 *     blocks for minutes is broken, however genuine the work behind it.
 *
 * The live console is where a real model belongs: there you *want* to watch it
 * think, and one journey at a time is the point. Set
 * `AGENTPROOF_REPORT_LLM=real` to opt the report pages in anyway.
 */
function reportLlm(): LLM {
  return process.env.AGENTPROOF_REPORT_LLM === "real"
    ? llmFromEnv()
    : new ScriptedLLM();
}

export function mutationsFor(variant: IntegrationVariant): MutationSet {
  return variant === "vulnerable"
    ? MutationSet.vulnerable()
    : MutationSet.fixed();
}

export interface DashboardEnvironmentInfo {
  policyVersion: string;
  policy: Policy;
  generatorModel: string;
  generatorIsReal: boolean;
  paymentAdapter: string;
  regressionCount: number;
  perturbationCount: number;
  generatedCount: number;
}

export interface SuiteView {
  variant: IntegrationVariant;
  suite: SuiteResult;
  info: DashboardEnvironmentInfo;
}

let cachedSuites: Partial<Record<IntegrationVariant, SuiteView>> = {};

/**
 * Runs the full suite for one integration variant.
 *
 * Memoised per process because navigating between dashboard pages should not
 * re-execute 24 journeys on every click, and the result is deterministic anyway.
 */
export async function getSuiteView(
  variant: IntegrationVariant,
): Promise<SuiteView> {
  const cached = cachedSuites[variant];
  if (cached) return cached;

  const llm = reportLlm();
  const policy = loadPolicyFromFile();
  const assembled = await assembleSuite({ llm, policy, generatedCount: 9 });

  const suite = await runSuite(assembled.scenarios, {
    mutations: mutationsFor(variant),
    runId: `dashboard_${variant}`,
  });

  const adapter = selectPaymentAdapter({
    ids: new IdFactory("dashboard"),
    clock: new ManualClock(),
  });

  const view: SuiteView = {
    variant,
    suite,
    info: {
      policyVersion: suite.policyVersion,
      policy,
      generatorModel: assembled.generatorModel,
      generatorIsReal: assembled.generatorIsReal,
      paymentAdapter: describeAdapter(adapter),
      regressionCount: assembled.regressionCount,
      perturbationCount: assembled.perturbationCount,
      generatedCount: assembled.generatedCount,
    },
  };
  cachedSuites[variant] = view;
  return view;
}

export function invalidateDashboardCache(): void {
  cachedSuites = {};
}

export async function getJourney(
  variant: IntegrationVariant,
  scenarioId: string,
): Promise<JourneyResult | null> {
  const view = await getSuiteView(variant);
  return view.suite.journeys.find((j) => j.scenarioId === scenarioId) ?? null;
}

export interface MutationScoreView {
  mutation: MutationId;
  title: string;
  description: string;
  expectedInvariant: string;
  detected: boolean;
  detectedBy: string[];
  scenarioId: string;
  escapes: number;
}

/** Regression scenario that exercises each seeded defect. */
const DEFECT_SCENARIOS: Record<MutationId, string> = {
  discount_stacking: "reg-09-discount-stacking",
  missing_quote_expiry: "reg-04-expired-quote",
  missing_price_version_check: "reg-07-price-changed",
  missing_inventory_revalidation: "reg-08-inventory-changed",
  missing_buyer_confirmation: "reg-06-missing-confirmation",
  missing_idempotency: "reg-05-duplicate-payment",
  incorrect_payment_state: "reg-11-payment-not-captured",
  unknown_allergen_safe: "reg-10-unknown-allergen",
};

let cachedScores: MutationScoreView[] | null = null;

/**
 * Scores each seeded defect in isolation.
 *
 * One mutant at a time, deliberately: with several active an upstream block can
 * mask a downstream defect and understate recall.
 */
export async function getMutationScores(): Promise<MutationScoreView[]> {
  if (cachedScores) return cachedScores;

  const llm = reportLlm();
  const policy = loadPolicyFromFile();
  const assembled = await assembleSuite({ llm, policy, generatedCount: 0 });
  const byId = new Map<string, Scenario>(
    assembled.scenarios.map((s) => [s.id, s]),
  );

  const scores: MutationScoreView[] = [];
  for (const mutation of MUTATION_IDS) {
    const descriptor = describeMutation(mutation);
    const scenarioId = DEFECT_SCENARIOS[mutation];
    const scenario = byId.get(scenarioId);
    if (!scenario) continue;

    const result = await runScenario(scenario, {
      mutations: MutationSet.only(mutation),
      runId: `dashboard_mutation_${mutation}`,
    });

    scores.push({
      mutation,
      title: descriptor.title,
      description: descriptor.description,
      expectedInvariant: descriptor.expectedInvariant,
      detected: result.firedInvariants.includes(descriptor.expectedInvariant),
      detectedBy: result.firedInvariants,
      scenarioId,
      escapes: result.duplicatePayableOrders,
    });
  }
  cachedScores = scores;
  return scores;
}

export interface EvaluationSummary {
  scores: MutationScoreView[];
  detected: number;
  total: number;
  recallPercent: number;
  falsePositives: number;
  falsePositiveTotal: number;
  falsePositivePercent: number;
  escapes: number;
}

export async function getEvaluationSummary(): Promise<EvaluationSummary> {
  const [scores, fixed] = await Promise.all([
    getMutationScores(),
    getSuiteView("fixed"),
  ]);

  const detected = scores.filter((s) => s.detected).length;
  const total = scores.length;
  // False positives are measured on the fixed integration: a journey flagged as
  // an integration defect when there is no defect to find.
  const falsePositives = fixed.suite.unsafeViolations;
  const falsePositiveTotal = fixed.suite.journeys.length;

  return {
    scores,
    detected,
    total,
    recallPercent: total === 0 ? 0 : (detected / total) * 100,
    falsePositives,
    falsePositiveTotal,
    falsePositivePercent:
      falsePositiveTotal === 0 ? 0 : (falsePositives / falsePositiveTotal) * 100,
    escapes: scores.reduce((sum, s) => sum + s.escapes, 0),
  };
}
