/**
 * The preflight run and the fix-and-rerun comparison (§9, §10, §17).
 *
 * Executes the regression suite against the vulnerable integration, prints the
 * readiness report, reruns the identical suite against the fixed integration,
 * then scores detection one mutant at a time.
 */
import { formatMinor } from "../lib/core/money.js";
import {
  MUTATION_IDS,
  MutationSet,
  describeMutation,
} from "../lib/hamperhub/mutations.js";
import {
  type MutationScore,
  renderMutationScorecard,
  renderPreflightReport,
} from "../lib/report/preflight.js";
import { renderTrace } from "../lib/report/trace.js";
import { createEnvironment, createIntent } from "../lib/harness.js";
import { runScenario, runSuite } from "../lib/runner/run.js";
import { assembleSuite } from "../lib/scenarios/index.js";
import { scenarioById } from "../lib/scenarios/regression.js";
import { llmFromEnv } from "../lib/agent/factory.js";
import { loadPolicyFromFile } from "../lib/policy/load.js";

/** Regression scenario that exercises each seeded defect. */
const DEFECT_SCENARIOS: Record<string, string> = {
  discount_stacking: "reg-09-discount-stacking",
  missing_quote_expiry: "reg-04-expired-quote",
  missing_price_version_check: "reg-07-price-changed",
  missing_inventory_revalidation: "reg-08-inventory-changed",
  missing_buyer_confirmation: "reg-06-missing-confirmation",
  missing_idempotency: "reg-05-duplicate-payment",
  incorrect_payment_state: "reg-11-payment-not-captured",
  unknown_allergen_safe: "reg-10-unknown-allergen",
};

async function main(): Promise<void> {
  // ---- 0. Assemble the suite: fixed regression + AI-generated ------------
  const llm = llmFromEnv();
  const policy = loadPolicyFromFile();
  const suite = await assembleSuite({ llm, policy, generatedCount: 12 });
  const provenance = {
    generatorModel: suite.generatorModel,
    generatorIsReal: suite.generatorIsReal,
    regressionCount: suite.regressionCount,
    generatedCount: suite.generatedCount,
  };

  // ---- 1. Vulnerable integration -----------------------------------------
  const before = await runSuite(suite.scenarios, {
    mutations: MutationSet.vulnerable(),
    runId: "preflight_vulnerable",
  });
  console.log(renderPreflightReport(before, provenance));

  // ---- 2. Replay one violation in full ------------------------------------
  console.log(`\n${"═".repeat(78)}\n`);
  console.log("Failure replay — discount stacking\n");
  const replayEnv = createEnvironment({
    mutations: MutationSet.vulnerable(),
  });
  const replayScenario = scenarioById("reg-09-discount-stacking")!;
  const replayIntent = createIntent(replayEnv.ids, replayEnv.clock, {
    runId: "replay",
    ...replayScenario.intent,
  });
  replayEnv.guard.beginIntent(replayIntent);
  await replayScenario.execute({
    env: replayEnv,
    guard: replayEnv.guard,
    intent: replayIntent,
  });
  console.log(renderTrace(replayEnv.audit.forIntent(replayIntent.id)));

  // ---- 3. Fixed integration, identical suite ------------------------------
  console.log(`\n${"═".repeat(78)}\n`);
  const after = await runSuite(suite.scenarios, {
    mutations: MutationSet.fixed(),
    runId: "preflight_fixed",
  });
  console.log(renderPreflightReport(after, provenance));

  // ---- 4. Mutation evaluation, one mutant at a time -----------------------
  console.log(`\n${"═".repeat(78)}\n`);
  const scores: MutationScore[] = [];
  for (const mutation of MUTATION_IDS) {
    const descriptor = describeMutation(mutation);
    const scenario = scenarioById(DEFECT_SCENARIOS[mutation]!)!;
    const result = await runScenario(scenario, {
      mutations: MutationSet.only(mutation),
      runId: `mutation_${mutation}`,
    });
    scores.push({
      mutation,
      expectedInvariant: descriptor.expectedInvariant,
      detected: result.firedInvariants.includes(descriptor.expectedInvariant),
      detectedBy: result.firedInvariants,
      escapes: result.duplicatePayableOrders,
    });
  }

  // False positives are measured on the fixed integration: any journey the
  // Guard flagged as an integration defect when there is no defect present.
  const falsePositives = {
    flagged: after.unsafeViolations,
    total: after.journeys.length,
  };
  console.log(renderMutationScorecard(scores, falsePositives));

  // ---- 5. Verdict ---------------------------------------------------------
  console.log(`\n${"═".repeat(78)}\n`);
  console.log("Before → after");
  console.log(
    `  Unsafe violations:      ${before.unsafeViolations} → ${after.unsafeViolations}`,
  );
  console.log(
    `  Money-critical escapes: ${before.moneyCriticalEscapes} → ${after.moneyCriticalEscapes}`,
  );
  console.log(
    `  Money at risk:          ${formatMinor(before.moneyAtRiskMinor)} → ${formatMinor(
      after.moneyAtRiskMinor,
    )}`,
  );
  console.log(`  Readiness:              ${before.readiness} → ${after.readiness}`);

  const undetected = scores.filter((s) => !s.detected);
  const failed =
    after.unsafeViolations > 0 ||
    after.moneyCriticalEscapes > 0 ||
    before.moneyCriticalEscapes > 0 ||
    undetected.length > 0 ||
    after.readiness !== "READY FOR CONTROLLED TEST";

  if (failed) {
    if (undetected.length > 0) {
      console.error(
        `\n✗ Undetected defects: ${undetected.map((s) => s.mutation).join(", ")}`,
      );
    }
    if (after.unsafeViolations > 0) {
      console.error(`✗ Fixed integration still reports unsafe violations`);
    }
    process.exit(1);
  }
  console.log(
    `\n✓ ${scores.length}/${scores.length} seeded defects detected, ` +
      `0 escapes, fixed integration READY.`,
  );
}

main().catch((error) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
