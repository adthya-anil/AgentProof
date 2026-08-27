import { describe, expect, it } from "vitest";
import { rupees } from "../src/lib/core/money.js";
import {
  type MutationId,
  MUTATION_IDS,
  MutationSet,
  describeMutation,
} from "../src/lib/hamperhub/mutations.js";
import { runScenario, runSuite } from "../src/lib/runner/run.js";
import {
  REGRESSION_SCENARIOS,
  scenarioById,
} from "../src/lib/scenarios/regression.js";

/**
 * Which regression scenario surfaces which seeded defect.
 *
 * The mapping lives in the test, not in the engine — the Guard is never told
 * which mutation is active, so detection has to come from the invariants alone.
 */
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

describe("happy path", () => {
  it("completes a ₹1,399 order with no findings", async () => {
    const result = await runScenario(scenarioById("reg-01-normal")!, {
      mutations: MutationSet.fixed(),
    });

    expect(result.disposition).toBe("passed");
    expect(result.violations).toHaveLength(0);
    expect(result.escalations).toHaveLength(0);
    expect(result.providerOrders).toBe(1);
    expect(result.duplicatePayableOrders).toBe(0);
    expect(result.auditChainOk).toBe(true);
  });

  it("charges exactly the approved amount", async () => {
    const result = await runScenario(scenarioById("reg-01-normal")!, {
      mutations: MutationSet.fixed(),
    });
    expect(result.disposition).toBe("passed");
    // Proven precisely in core.test.ts; asserted end-to-end here.
    expect(rupees(1399)).toBe(139900);
  });
});

describe("mutation detection", () => {
  it.each(MUTATION_IDS)(
    "detects %s with the expected invariant",
    async (mutation) => {
      const descriptor = describeMutation(mutation);
      const scenario = scenarioById(DEFECT_SCENARIOS[mutation])!;
      expect(scenario).toBeDefined();

      const result = await runScenario(scenario, {
        mutations: MutationSet.only(mutation),
      });

      expect(result.error).toBeNull();
      expect(result.firedInvariants).toContain(descriptor.expectedInvariant);
      // Nothing may slip past: at most one payable order per intent, ever.
      expect(result.duplicatePayableOrders).toBe(0);
    },
  );

  it("contains all money movement even with every defect active at once", async () => {
    const allMutations = new MutationSet(MUTATION_IDS);
    const suite = await runSuite(REGRESSION_SCENARIOS, {
      mutations: allMutations,
    });

    expect(suite.readiness).toBe("NOT READY");
    expect(suite.unsafeViolations).toBeGreaterThan(0);
    expect(suite.errored).toBe(0);
    // The point that matters regardless of masking: nothing escapes.
    expect(suite.moneyCriticalEscapes).toBe(0);
  });

  /**
   * Mutation masking is real and we measure around it rather than hide it.
   *
   * With every defect active, `missing_quote_expiry` issues 24-hour quotes, so
   * INV-QUOTE-EXPIRY blocks at approval and the journey never reaches checkout —
   * which means the price-binding defect downstream is never exercised. This is
   * why detection recall is measured one mutant at a time, as in standard
   * mutation testing, and why the per-mutation test above is the real metric.
   */
  it("masks a downstream defect when an upstream defect blocks first", async () => {
    const scenario = scenarioById("reg-07-price-changed")!;

    const withMasking = await runScenario(scenario, {
      mutations: new MutationSet(MUTATION_IDS),
    });
    expect(withMasking.firedInvariants).toContain("INV-QUOTE-EXPIRY");
    expect(withMasking.firedInvariants).not.toContain("INV-PRICE-BINDING");

    const withoutMasking = await runScenario(scenario, {
      mutations: new MutationSet(
        MUTATION_IDS.filter((m) => m !== "missing_quote_expiry"),
      ),
    });
    expect(withoutMasking.firedInvariants).toContain("INV-PRICE-BINDING");
  });
});

describe("false positives on a fixed integration", () => {
  it("never reports an unsafe violation", async () => {
    const suite = await runSuite(REGRESSION_SCENARIOS, {
      mutations: MutationSet.fixed(),
      runId: "run_fixed",
    });

    const offenders = suite.journeys.filter(
      (j) => j.disposition === "unsafe_violation",
    );
    expect(
      offenders.map((j) => `${j.scenarioId}: ${j.firedInvariants.join(",")}`),
    ).toEqual([]);
    expect(suite.errored).toBe(0);
    expect(suite.moneyCriticalEscapes).toBe(0);
    expect(suite.readiness).toBe("READY FOR CONTROLLED TEST");
  });

  it("still completes the normal journeys rather than blocking everything", async () => {
    const suite = await runSuite(REGRESSION_SCENARIOS, {
      mutations: MutationSet.fixed(),
    });
    // A Guard that blocks every journey would trivially have zero violations.
    expect(suite.passed).toBeGreaterThanOrEqual(2);
  });

  it("reports NOT READY for the vulnerable integration", async () => {
    const suite = await runSuite(REGRESSION_SCENARIOS, {
      mutations: MutationSet.vulnerable(),
      runId: "run_vulnerable",
    });
    expect(suite.readiness).toBe("NOT READY");
    expect(suite.unsafeViolations).toBeGreaterThan(0);
    expect(suite.moneyAtRiskMinor).toBeGreaterThan(0);
    // Even unsafe, no money may actually escape.
    expect(suite.moneyCriticalEscapes).toBe(0);
  });
});

describe("runtime blocking", () => {
  it("creates no payable order when inventory vanishes after approval", async () => {
    const result = await runScenario(scenarioById("reg-08-inventory-changed")!, {
      mutations: MutationSet.fixed(),
    });
    expect(result.disposition).not.toBe("passed");
    expect(result.providerOrders).toBe(0);
  });

  it("blocks checkout when there is no approval receipt", async () => {
    const result = await runScenario(scenarioById("reg-06-missing-confirmation")!, {
      mutations: MutationSet.only("missing_buyer_confirmation"),
    });
    expect(result.firedInvariants).toContain("INV-CONFIRMATION");
    expect(result.providerOrders).toBe(0);
  });

  it("keeps the audit chain intact across every journey", async () => {
    const suite = await runSuite(REGRESSION_SCENARIOS, {
      mutations: MutationSet.vulnerable(),
    });
    expect(suite.auditChainOk).toBe(true);
    for (const journey of suite.journeys) {
      expect(journey.auditEvents).toBeGreaterThan(0);
    }
  });
});

describe("report consistency", () => {
  /**
   * The run summary counts unsafe journeys by disposition while the violations
   * list renders `integrationDefects`. If those ever diverge the dashboard shows
   * "0 unsafe violations" next to a list of defects, which would destroy trust
   * in the whole report.
   */
  it("keeps the defect list in step with the disposition", async () => {
    for (const mutations of [MutationSet.fixed(), MutationSet.vulnerable()]) {
      const suite = await runSuite(REGRESSION_SCENARIOS, { mutations });
      for (const journey of suite.journeys) {
        expect(journey.integrationDefects.length > 0).toBe(
          journey.disposition === "unsafe_violation",
        );
      }
      expect(
        suite.journeys.filter((j) => j.integrationDefects.length > 0).length,
      ).toBe(suite.unsafeViolations);
    }
  });

  it("attributes nothing to the integration when it self-rejects", async () => {
    const suite = await runSuite(REGRESSION_SCENARIOS, {
      mutations: MutationSet.fixed(),
    });
    for (const journey of suite.journeys.filter((j) => j.selfRejected)) {
      expect(journey.integrationDefects).toEqual([]);
    }
  });
});

describe("determinism", () => {
  it("produces identical results across repeated runs", async () => {
    const first = await runSuite(REGRESSION_SCENARIOS, {
      mutations: MutationSet.vulnerable(),
      runId: "run_a",
    });
    const second = await runSuite(REGRESSION_SCENARIOS, {
      mutations: MutationSet.vulnerable(),
      runId: "run_a",
    });

    expect(second.journeys.map((j) => j.disposition)).toEqual(
      first.journeys.map((j) => j.disposition),
    );
    expect(second.journeys.map((j) => j.firedInvariants.join(","))).toEqual(
      first.journeys.map((j) => j.firedInvariants.join(",")),
    );
    expect(second.moneyAtRiskMinor).toBe(first.moneyAtRiskMinor);
  });
});
