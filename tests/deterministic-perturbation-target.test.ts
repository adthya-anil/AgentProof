import { describe, expect, it } from "vitest";
import { MutationSet } from "../src/lib/hamperhub/mutations.js";
import { runSuite } from "../src/lib/runner/run.js";
import {
  REGRESSION_SCENARIOS,
  contestedProduct,
} from "../src/lib/scenarios/regression.js";
import type { Scenario } from "../src/lib/scenarios/types.js";

/**
 * Review issue 1 (CONFIRMED): the deterministic reg-07 / reg-08 reproductions land on
 * `p-coffee-arabica` only incidentally.
 *
 * FEAT-003 replaced the hardcoded arabica shelf with `contestedProduct`, which prefers the
 * product in the buyer's most-recent quote. On HamperHub that still resolves to arabica
 * because the scripted HAMPER bundle lists `p-coffee-arabica` FIRST and `create_quote`
 * preserves that ordering into `lineItems`, so the first surviving line item is arabica.
 *
 * That coupling is implicit: nothing named arabica any more, and no test pinned it. A future
 * change to the HAMPER bundle order, or to how `create_quote` orders `lineItems`, would move
 * the deterministic fault onto a different product and silently break the arabica
 * reproduction while every existing test stayed green.
 *
 * These tests make the dependency bite. If the fault ever drifts off arabica — whether from
 * a quote/bundle reordering, or from reverting `contestedProduct` to name-first (which is a
 * no-op here but would be the tell if the buyer-tracking fix were undone) — the deterministic
 * perturbation would land elsewhere and these assertions would fail rather than the
 * reproduction quietly changing shape.
 */

const ARABICA_ID = "p-coffee-arabica";
const ARABICA_NAME = "Arabica Single-Origin Coffee 250g";

/**
 * Runs `contestedProduct` at the interference point of one regression scenario against
 * HamperHub, without mutating anything, and returns the product it would perturb.
 *
 * Wraps the scenario's own interference in a spy so it exercises the real `create_bundle` ->
 * `create_quote` -> `approve_quote` path that seeds the quote `contestedProduct` scans.
 */
async function chosenPerturbationTarget(scenarioId: string): Promise<string | null> {
  const original = REGRESSION_SCENARIOS.find((s) => s.id === scenarioId);
  if (!original) throw new Error(`no regression scenario '${scenarioId}'`);

  let chosen: string | null = null;
  const spy: Scenario = {
    ...original,
    interference: {
      ...original.interference!,
      // Observe only: record what contestedProduct picks, change nothing. Not throwing
      // keeps the journey from erroring, which is irrelevant to what we assert.
      apply: (env) => {
        chosen = contestedProduct(env, ARABICA_ID)?.productId ?? null;
      },
    },
  };

  await runSuite([spy], { mutations: MutationSet.vulnerable() });
  return chosen;
}

describe("the deterministic reg-07/reg-08 reproductions land on arabica, and stay pinned to it", () => {
  it("reg-07 (price drift) perturbs p-coffee-arabica, the first HAMPER line item", async () => {
    const chosen = await chosenPerturbationTarget("reg-07-price-changed");
    expect(
      chosen,
      "reg-07's price-drift fault must land on p-coffee-arabica; if the HAMPER bundle " +
        "order or create_quote's lineItem ordering changes, the deterministic reproduction " +
        "silently drifts to another product",
    ).toBe(ARABICA_ID);
  });

  it("reg-08 (stock-out) perturbs p-coffee-arabica, the first HAMPER line item", async () => {
    const chosen = await chosenPerturbationTarget("reg-08-inventory-changed");
    expect(
      chosen,
      "reg-08's stock-out fault must land on p-coffee-arabica; if the HAMPER bundle " +
        "order or create_quote's lineItem ordering changes, the deterministic reproduction " +
        "silently drifts to another product",
    ).toBe(ARABICA_ID);
  });

  it("reg-07 fires INV-PRICE-BINDING with the fault applied to the arabica shelf", async () => {
    const suite = await runSuite(
      REGRESSION_SCENARIOS.filter((s) => s.id === "reg-07-price-changed"),
      { mutations: MutationSet.vulnerable() },
    );
    const journey = suite.journeys[0]!;

    // The reproduction is a real finding, not a silent pass.
    expect(journey.firedInvariants).toContain("INV-PRICE-BINDING");
    expect(journey.disposition).not.toBe("passed");
    // The applied fault, recorded in the journey note, names arabica specifically. This is
    // the observable proof the perturbation reached the arabica shelf and not another.
    expect(journey.note).toContain(ARABICA_NAME);
    expect(journey.note).toContain("fault applied");
  });

  it("reg-08 fires INV-INVENTORY with the fault applied to the arabica shelf", async () => {
    const suite = await runSuite(
      REGRESSION_SCENARIOS.filter((s) => s.id === "reg-08-inventory-changed"),
      { mutations: MutationSet.vulnerable() },
    );
    const journey = suite.journeys[0]!;

    expect(journey.firedInvariants).toContain("INV-INVENTORY");
    expect(journey.disposition).not.toBe("passed");
    // The stock-out effect names the arabica shelf reconciled to zero.
    expect(journey.note).toContain(ARABICA_NAME);
    expect(journey.note).toContain("stock");
  });
});
