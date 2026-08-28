import { llmFromEnv, llmPoolFromEnv } from "../agent/factory.js";
import { describeAdapter, selectPaymentAdapter } from "../payments/factory.js";
import { IdFactory } from "../core/ids.js";
import { ManualClock } from "../core/clock.js";
import { Db } from "../db/client.js";
import { concurrencyBackendsFromDb } from "../db/concurrency.js";
import {
  MUTATION_IDS,
  type MutationId,
  MutationSet,
  describeMutation,
} from "../hamperhub/mutations.js";
import { loadPolicyFromFile } from "../policy/load.js";
import type { Policy } from "../policy/schema.js";
import { type JourneyResult, type SuiteResult, runScenario } from "../runner/run.js";
import { assembleSuite } from "../scenarios/index.js";
import type { Scenario } from "../scenarios/types.js";
import { getLatestRun, type StoredRun } from "./runStore.js";

/**
 * Read model for the dashboard.
 *
 * These functions **never execute a suite**. Report pages render runs that were
 * triggered deliberately, because with a real model a suite costs minutes and
 * real tokens, and a page load must not spend either on the reader's behalf.
 *
 * A run is started from the dashboard, streamed while it happens, and stored.
 * Pages then read the stored result, which is why they are instant.
 */

export type IntegrationVariant = "vulnerable" | "fixed";

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
  /**
   * The model given the adversary role, when roles were split.
   *
   * Needed so a stored report can describe how it was produced. The by-model table
   * asserted a cross-product that a split run never performs, and without this field
   * it had no way to know the difference.
   */
  adversaryModel?: string | null;
  paymentAdapter: string;
  regressionCount: number;
  perturbationCount: number;
  liveCount: number;
  generatedCount: number;
  startedAt: string;
  finishedAt: string;
  persistedSuiteId: string | null;
}

export interface SuiteView {
  variant: IntegrationVariant;
  suite: SuiteResult;
  info: DashboardEnvironmentInfo;
}

/**
 * The most recent completed run for a variant, or null when none has been
 * triggered yet. Callers must render a "start a run" state for null rather than
 * quietly running one.
 */
export async function getSuiteView(
  variant: IntegrationVariant,
): Promise<SuiteView | null> {
  const stored = await getLatestRun(variant);
  return stored ? toView(stored) : null;
}

function toView(stored: StoredRun): SuiteView {
  return {
    variant: stored.variant,
    suite: stored.suite,
    info: {
      policyVersion: stored.suite.policyVersion,
      policy: loadPolicyFromFile(),
      generatorModel: stored.model,
      generatorIsReal: stored.modelIsReal,
      adversaryModel: stored.adversaryModel ?? null,
      paymentAdapter: stored.paymentAdapter,
      regressionCount: stored.regressionCount,
      perturbationCount: stored.perturbationCount,
      liveCount: stored.liveCount,
      generatedCount: stored.generatedCount,
      startedAt: stored.startedAt,
      finishedAt: stored.finishedAt,
      persistedSuiteId: stored.persistedSuiteId,
    },
  };
}

export async function getJourney(
  variant: IntegrationVariant,
  scenarioId: string,
): Promise<JourneyResult | null> {
  const view = await getSuiteView(variant);
  return view?.suite.journeys.find((j) => j.scenarioId === scenarioId) ?? null;
}

/**
 * Which locking and uniqueness implementations a run would use right now.
 *
 * Derived from configuration rather than from a live environment, so the panel can say
 * it before anything runs — the same reason the model pool is reported up front.
 */
function describeConcurrency(): {
  locks: string;
  payableOrders: string;
  crossProcess: boolean;
} {
  const db = Db.fromEnv();
  if (!db) {
    return {
      locks: "in-process",
      payableOrders: "in-process",
      crossProcess: false,
    };
  }
  const backends = concurrencyBackendsFromDb(db);
  return {
    locks: backends.locks.name,
    payableOrders: backends.payableOrders.name,
    crossProcess: true,
  };
}

/** Describes the configured engine without running anything. */
export function describeEngine(): {
  model: string;
  modelIsReal: boolean;
  /** Every model that will drive a journey, not just the primary one. */
  pool: string[];
  /** Credentials are present. Says nothing about whether a run uses them. */
  razorpayConfigured: boolean;
  razorpayKeyId: string | null;
  paymentAdapter: string;
  policyVersion: string;
  /**
   * Which concurrency guarantees are actually in force.
   *
   * Reported for the same reason the Razorpay line distinguishes "configured" from
   * "in use": in-process locking is a real guarantee for one process and no guarantee
   * at all for two, and a panel that stayed silent would let a reader assume the
   * stronger one. `scope` is null when there is no database, because a claim namespace
   * without a shared store to hold it means nothing.
   */
  concurrency: { locks: string; payableOrders: string; crossProcess: boolean };
} {
  let model = "unconfigured";
  let modelIsReal = false;
  try {
    const llm = llmFromEnv();
    model = llm.name;
    modelIsReal = llm.isReal;
  } catch {
    // An unconfigured or misconfigured model is a state to display, not throw on.
  }

  /**
   * The whole pool, reported before any run starts.
   *
   * This panel used to show only the primary adapter, which meant a correctly
   * configured second model was invisible until a run was already underway — so
   * the one way to check your configuration was to spend tokens on it. Worse, the
   * panel read "MODEL: openai:gpt-5.6-sol" in the singular, which is affirmative
   * evidence for the wrong conclusion.
   */
  let pool: string[] = [];
  try {
    pool = llmPoolFromEnv().map((llm) => llm.name);
  } catch {
    // Same reasoning: a broken pool is a state to render, not to throw on.
  }

  /**
   * Whether Razorpay credentials exist — not whether a run will use them.
   *
   * The distinction is the whole point. This used to report the selected adapter,
   * which read as "every journey hits Razorpay" on a page where no journey did.
   * Credentials being present is a fact about the environment; using them is a
   * decision made per run and reported by that run.
   */
  const keyId = process.env.RAZORPAY_KEY_ID?.trim();
  const razorpayConfigured = Boolean(keyId && process.env.RAZORPAY_KEY_SECRET);
  const adapter = selectPaymentAdapter({
    ids: new IdFactory("describe"),
    clock: new ManualClock(),
  });
  const policy = loadPolicyFromFile();
  return {
    model,
    modelIsReal,
    pool,
    razorpayConfigured,
    razorpayKeyId: keyId ?? null,
    concurrency: describeConcurrency(),
    paymentAdapter: describeAdapter(adapter),
    policyVersion: `${policy.policyId}`,
  };
}

// ---------------------------------------------------------------------------
// Mutation evaluation
// ---------------------------------------------------------------------------

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

export function getCachedMutationScores(): MutationScoreView[] | null {
  return cachedScores;
}

/**
 * Scores each seeded defect in isolation, one mutant at a time.
 *
 * Uses the fixed regression scenarios rather than agent-driven ones, so the
 * measurement is a deterministic reproduction: recall must not vary because a
 * model chose a different route on a given afternoon. Triggered explicitly and
 * cached, like every other run.
 */
export interface MutationScoringProgress {
  onMutationStart?: (
    mutation: MutationId,
    index: number,
    total: number,
  ) => void;
  onMutationScored?: (
    score: MutationScoreView,
    index: number,
    total: number,
  ) => void;
}

export async function computeMutationScores(
  progress: MutationScoringProgress = {},
): Promise<MutationScoreView[]> {
  const policy = loadPolicyFromFile();
  const llm = llmFromEnv();
  // generatedCount 0: this measurement needs the deterministic regression set.
  const assembled = await assembleSuite({ llm, policy, generatedCount: 0 });
  const byId = new Map<string, Scenario>(
    assembled.scenarios.map((s) => [s.id, s]),
  );

  const scores: MutationScoreView[] = [];
  let index = 0;
  for (const mutation of MUTATION_IDS) {
    const position = index;
    index += 1;
    progress.onMutationStart?.(mutation, position, MUTATION_IDS.length);

    const descriptor = describeMutation(mutation);
    const scenario = byId.get(DEFECT_SCENARIOS[mutation]);
    if (!scenario) continue;

    const result = await runScenario(scenario, {
      mutations: MutationSet.only(mutation),
      runId: `mutation_${mutation}`,
    });

    const score: MutationScoreView = {
      mutation,
      title: descriptor.title,
      description: descriptor.description,
      expectedInvariant: descriptor.expectedInvariant,
      detected: result.firedInvariants.includes(descriptor.expectedInvariant),
      detectedBy: result.firedInvariants,
      scenarioId: DEFECT_SCENARIOS[mutation],
      escapes: result.duplicatePayableOrders,
    };
    scores.push(score);
    progress.onMutationScored?.(score, position, MUTATION_IDS.length);
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

/**
 * Builds the evaluation summary from whatever has already been measured.
 * Returns null until both a mutation scoring and a fixed-integration run exist.
 */
export async function getEvaluationSummary(): Promise<EvaluationSummary | null> {
  const scores = cachedScores;
  if (!scores || scores.length === 0) return null;

  const fixed = await getSuiteView("fixed");
  const detected = scores.filter((s) => s.detected).length;
  const total = scores.length;

  // False positives are only meaningful against an integration with no defects.
  const falsePositives = fixed?.suite.unsafeViolations ?? 0;
  const falsePositiveTotal = fixed?.suite.journeys.length ?? 0;

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
