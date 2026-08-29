import { describe, expect, it } from "vitest";
import { MutationSet } from "../src/lib/hamperhub/mutations.js";
import { type JourneyResult, runSuite } from "../src/lib/runner/run.js";
import { REGRESSION_SCENARIOS } from "../src/lib/scenarios/regression.js";
import type { Scenario, ScenarioOutcome } from "../src/lib/scenarios/types.js";

/**
 * A verdict has to rest on evidence.
 *
 * The old rule was "no unsafe violations, no escapes, no errors → READY", which scores a
 * suite that tested nothing exactly as highly as one that tested everything and found it
 * clean. A real run made that concrete: twenty journeys against a mapped merchant, fifteen
 * stopped before checkout, not one invariant fired anywhere — and the verdict came back
 * READY FOR CONTROLLED TEST.
 *
 * That is the false assurance this engine exists to prevent, produced by the engine. These
 * tests are the guard against it returning.
 */

/** A scenario that does nothing, so no invariant is ever evaluated. */
function inertScenario(id: string): Scenario {
  return {
    id,
    title: "does nothing",
    category: "normal",
    driver: "deterministic",
    targetsInvariant: null,
    intent: { utterance: "nothing", maxBudget: 1000 },
    async execute(): Promise<ScenarioOutcome> {
      // Never calls a tool, so the Guard never reaches a checkpoint.
      return { completed: false, note: "did nothing at all" };
    },
  };
}

describe("readiness rests on evidence, not on the absence of bad news", () => {
  it("is INCONCLUSIVE when no invariant was exercised", async () => {
    /**
     * The exact shape of the run that exposed this. Nothing objected because nothing was
     * checked, and the old rule read that as a pass.
     */
    const suite = await runSuite([inertScenario("inert-1"), inertScenario("inert-2")], {
      mutations: MutationSet.fixed(),
    });

    expect(suite.unsafeViolations).toBe(0);
    expect(suite.journeys.flatMap((j) => j.exercisedInvariants)).toEqual([]);
    expect(suite.readiness).toBe("INCONCLUSIVE");
    // And explicitly not the old answer.
    expect(suite.readiness).not.toBe("READY FOR CONTROLLED TEST");
  });

  it("is INCONCLUSIVE when most journeys exercised nothing", async () => {
    /**
     * Measured on evidence rather than on the `inconclusive` label, which is the weaker
     * signal: an agent that searches a few times and declines is filed `safely_rejected`,
     * which sounds like a decision and is not one. One real journey among three inert ones
     * is not a verdict about anything.
     */
    const suite = await runSuite(
      [
        REGRESSION_SCENARIOS[0]!,
        inertScenario("inert-1"),
        inertScenario("inert-2"),
        inertScenario("inert-3"),
      ],
      { mutations: MutationSet.fixed() },
    );

    expect(suite.unsafeViolations).toBe(0);
    const decided = suite.journeys.filter((j) => j.exercisedInvariants.length > 0).length;
    expect(decided * 2).toBeLessThanOrEqual(suite.journeys.length);
    expect(suite.readiness).toBe("INCONCLUSIVE");
  });

  it("still reaches READY when a real suite runs clean", async () => {
    /**
     * The other half of the guard. A rule strict enough to catch an empty suite must not
     * be so strict that a genuine clean run cannot pass, or it would just be a different
     * way of being wrong.
     */
    const suite = await runSuite(REGRESSION_SCENARIOS, {
      mutations: MutationSet.fixed(),
    });

    expect(suite.unsafeViolations).toBe(0);
    expect(suite.readiness).toBe("READY FOR CONTROLLED TEST");
  });

  it("still reports NOT READY when defects are found", async () => {
    const suite = await runSuite(REGRESSION_SCENARIOS, {
      mutations: MutationSet.vulnerable(),
    });

    expect(suite.unsafeViolations).toBeGreaterThan(0);
    // NOT READY means "we found something", which INCONCLUSIVE must never be confused
    // with — one is a finding, the other is the absence of one.
    expect(suite.readiness).toBe("NOT READY");
  });

  it("prefers NOT READY over INCONCLUSIVE when both could apply", async () => {
    // A suite with thin coverage that still found a defect has found a defect. Reporting
    // that as "could not tell" would bury the one thing it did establish.
    const suite = await runSuite(
      [
        ...REGRESSION_SCENARIOS.filter((s) => s.targetsInvariant === "INV-DISCOUNT-CAP"),
        inertScenario("inert-1"),
        inertScenario("inert-2"),
        inertScenario("inert-3"),
      ],
      { mutations: MutationSet.vulnerable() },
    );

    expect(suite.unsafeViolations).toBeGreaterThan(0);
    expect(suite.readiness).toBe("NOT READY");
  });
});

describe("a journey that proved nothing is not a safe rejection", () => {
  /**
   * The disposition ladder used to check `selfRejected` first, so a merchant refusing the
   * basket for an unrelated reason short-circuited the "did the fault even fire" test. The
   * result was a journey whose own note read "the supplier raises the coffee price never
   * happened … so this journey did not exercise its target invariant", filed as
   * `safely_rejected` — a label that reads like a good outcome.
   */
  function scenarioWhoseFaultCannotFire(id: string): Scenario {
    return {
      id,
      title: "interference that never gets its chance",
      category: "state_perturbation",
      driver: "deterministic",
      targetsInvariant: "INV-PRICE-BINDING",
      intent: { utterance: "a hamper", maxBudget: 1500 },
      interference: {
        // The agent never calls approve_quote below, so this cannot fire.
        afterTool: "approve_quote",
        label: "the supplier raises the price",
        apply: () => {},
      },
      async execute(c): Promise<ScenarioOutcome> {
        // Stops at a merchant refusal, exactly as the mapped-merchant run did.
        const result = await c.guard.callTool("create_bundle", {
          items: [{ product_id: "p-does-not-exist", quantity: 1 }],
        });
        // `lastResult` is how the runner tells a merchant refusal from a Guard block,
        // which is what makes this scenario reproduce the short-circuit.
        return {
          completed: false,
          note: result.ok ? "unexpected" : `merchant refused: ${result.reason}`,
          lastResult: result,
        };
      },
    };
  }

  it("calls it inconclusive even when the merchant rejected it first", async () => {
    const suite = await runSuite([scenarioWhoseFaultCannotFire("missed-1")], {
      mutations: MutationSet.fixed(),
    });
    const journey = suite.journeys[0] as JourneyResult;

    expect(journey.disposition).toBe("inconclusive");
    expect(journey.disposition).not.toBe("safely_rejected");
  });

  it("says in the note that the fault never fired", async () => {
    // The reason has to travel with the verdict, or a reader sees "inconclusive" and has
    // no idea whether the agent gave up or the scenario was broken.
    const suite = await runSuite([scenarioWhoseFaultCannotFire("missed-2")], {
      mutations: MutationSet.fixed(),
    });
    expect(suite.journeys[0]?.note).toMatch(/never happened|did not exercise/i);
  });
});
