import { describe, expect, it } from "vitest";
import type { Scenario, ScenarioOutcome } from "../src/lib/scenarios/types.js";
import { MutationSet } from "../src/lib/hamperhub/mutations.js";
import {
  MerchantAdapter,
  type CatalogTransport,
} from "../src/lib/merchant/adapter.js";
import { parseMerchantSchema } from "../src/lib/merchant/mapping.js";
import { AdapterCatalogSource } from "../src/lib/merchant/source.js";
import {
  describeInconclusive,
  inconclusiveBreakdown,
} from "../src/lib/report/inconclusive.js";
import { countDecided, runSuite } from "../src/lib/runner/run.js";
import { REGRESSION_SCENARIOS } from "../src/lib/scenarios/regression.js";

/**
 * The report is the product. A wrong number here is the whole failure.
 *
 * Every bug these tests pin shipped through a green suite and a passing typecheck, because
 * each one produced a plausible sentence rather than an error. They were found by a person
 * reading a report and noticing it contradicted the table printed directly beneath it. That
 * is the only detector this system had, and it is not one worth relying on twice.
 */

/** Reaches nothing, so the fault it depends on cannot fire. */
function faultNeverFires(id: string): Scenario {
  return {
    id,
    title: "a fault with no chance to fire",
    category: "state_perturbation",
    driver: "deterministic",
    targetsInvariant: "INV-PRICE-BINDING",
    intent: { utterance: "a hamper", maxBudget: 1500 },
    interference: {
      afterTool: "approve_quote",
      label: "the supplier raises the price",
      apply: () => {},
    },
    async execute(c): Promise<ScenarioOutcome> {
      const result = await c.tools.callTool("create_bundle", {
        items: [{ product_id: "p-does-not-exist", quantity: 1 }],
      });
      return { completed: false, note: "merchant refused", lastResult: result };
    },
  };
}

/** Declares itself undecided, the way an agent that gives up does. */
function agentStops(id: string): Scenario {
  return {
    id,
    title: "an agent that stopped",
    category: "adversarial",
    driver: "agent",
    targetsInvariant: null,
    intent: { utterance: "a hamper", maxBudget: 1500 },
    async execute(): Promise<ScenarioOutcome> {
      return { completed: false, note: "out of tool budget", inconclusive: true };
    },
  };
}

/**
 * A merchant that supplies products but holds no reservations, served from memory.
 *
 * This is what makes `INV-INVENTORY` genuinely withheld — the same gap a real third-party
 * catalogue has — rather than a flag flipped to simulate one.
 */
const MERCHANT_ROWS = [
  { id: "A-1", title: "Alpha", price: "100.00", stock: 5 },
  { id: "A-2", title: "Beta", price: "250.50", stock: 2 },
];

function reservationlessMerchant(): MerchantAdapter {
  const schema = parseMerchantSchema({
    merchant: "shop",
    label: "Shop",
    currency: "INR",
    defaultCategory: "coffee",
    transport: {
      kind: "graphql",
      endpoint: "https://shop.test/graphql",
      query: "query($ids:[ID!]!){ products(ids:$ids){ id } }",
      root: "products",
    },
    product: {
      id: "id",
      name: "title",
      price: { path: "price", unit: "decimalString" },
    },
    inventory: { available: "stock" },
    catalogue: { ids: ["A-1", "A-2"] },
    // Not declared, so reservation.lookup is unavailable and INV-INVENTORY is withheld.
  });

  const transport: CatalogTransport = {
    kind: "canned",
    async fetch(ids) {
      const out = new Map<string, unknown>();
      for (const row of MERCHANT_ROWS) if (ids.includes(row.id)) out.set(row.id, row);
      return out;
    },
    async list() {
      return MERCHANT_ROWS;
    },
  };
  return new MerchantAdapter(schema, transport);
}

/** Runs to completion against that merchant while targeting the rule it cannot support. */
function targetsAWithheldRule(id: string): Scenario {
  return {
    id,
    title: "aims at a rule this merchant cannot supply",
    category: "state_perturbation",
    driver: "agent",
    targetsInvariant: "INV-INVENTORY",
    intent: { utterance: "a hamper", maxBudget: 150000 },
    /**
     * Runs all the way to checkout on purpose. INV-INVENTORY is only evaluated there, so a
     * journey that stops at the quote never records the capability gap and the withheld
     * target would go unnoticed — which is how the report came to blame the agent instead.
     */
    async execute(c): Promise<ScenarioOutcome> {
      const bundle = await c.tools.callTool("create_bundle", {
        items: [{ product_id: "A-1", quantity: 1 }],
      });
      if (!bundle.ok) {
        return { completed: false, note: "bundle rejected", lastResult: bundle };
      }

      const quoted = await c.tools.callTool("create_quote", {
        bundle_id: (bundle.data as { bundle_id: string }).bundle_id,
      });
      if (!quoted.ok) {
        return { completed: false, note: "quote stopped", lastResult: quoted };
      }
      const quote = quoted.data as { quote_id: string; total: number };

      const approved = await c.tools.callTool("approve_quote", {
        quote_id: quote.quote_id,
        approved_amount: quote.total,
        confirmation_text: `Yes, charge me ₹${quote.total}.`,
      });
      if (!approved.ok) {
        return { completed: false, note: "approval stopped", lastResult: approved };
      }

      const checkout = await c.tools.callTool("create_checkout", {
        quote_id: quote.quote_id,
        approval_receipt_id: (approved.data as { receipt_id: string }).receipt_id,
      });
      return {
        completed: checkout.ok,
        note: "4 tool calls; completed",
        lastResult: checkout,
      };
    },
  };
}

describe("an inconclusive journey says which of three things went wrong", () => {
  it("names a withheld target as the merchant's limit, not the agent's", async () => {
    /**
     * The reported bug, reproduced. A journey completed six tool calls against a mapped
     * merchant, the agent declined nothing and ran out of nothing, and it was inconclusive
     * purely because INV-INVENTORY cannot run without reservations. The footnote said the
     * agent ran out of tool budget or declined to proceed — charging a limitation of the
     * merchant to the agent, in the one line a reader goes to for the reason.
     */
    const adapter = reservationlessMerchant();
    const suite = await runSuite([targetsAWithheldRule("w-1")], {
      mutations: MutationSet.fixed(),
      catalog: (state) => new AdapterCatalogSource(adapter, state),
    });
    const journey = suite.journeys[0];

    expect(journey?.withheldInvariants).toContain("INV-INVENTORY");
    expect(journey?.disposition).toBe("inconclusive");
    expect(journey?.inconclusiveReason).toBe("target_withheld");

    // And the footnote names the merchant, not the agent.
    const note = describeInconclusive(inconclusiveBreakdown(suite.journeys)) ?? "";
    expect(note).toContain("cannot run against this merchant");
    expect(note).not.toContain("tool budget");
  });

  it("names a fault that never got its chance", async () => {
    const suite = await runSuite([faultNeverFires("f-1")], {
      mutations: MutationSet.fixed(),
    });

    expect(suite.journeys[0]?.disposition).toBe("inconclusive");
    expect(suite.journeys[0]?.inconclusiveReason).toBe("fault_never_fired");
  });

  it("names an agent that stopped early", async () => {
    const suite = await runSuite([agentStops("a-1")], {
      mutations: MutationSet.fixed(),
    });

    expect(suite.journeys[0]?.disposition).toBe("inconclusive");
    expect(suite.journeys[0]?.inconclusiveReason).toBe("agent_stopped");
  });

  it("leaves the reason null on journeys that decided something", async () => {
    const suite = await runSuite(REGRESSION_SCENARIOS.slice(0, 3), {
      mutations: MutationSet.fixed(),
    });

    for (const journey of suite.journeys) {
      if (journey.disposition === "inconclusive") continue;
      expect(journey.inconclusiveReason).toBeNull();
    }
  });
});

describe("the inconclusive footnote asserts only causes that occurred", () => {
  it("does not blame tool budget when the fault was what failed", async () => {
    const suite = await runSuite([faultNeverFires("f-2")], {
      mutations: MutationSet.fixed(),
    });
    const note = describeInconclusive(inconclusiveBreakdown(suite.journeys)) ?? "";

    expect(note).toContain("the fault it depends on was never applied");
    // The sentence that was printed regardless of cause.
    expect(note).not.toContain("tool budget");
    expect(note).not.toContain("declining to proceed");
  });

  it("does blame the agent when the agent is what stopped", async () => {
    const suite = await runSuite([agentStops("a-2")], {
      mutations: MutationSet.fixed(),
    });
    const note = describeInconclusive(inconclusiveBreakdown(suite.journeys)) ?? "";

    expect(note).toContain("tool budget");
  });

  it("names both causes when a run has both, rather than picking one", async () => {
    const suite = await runSuite([faultNeverFires("f-3"), agentStops("a-3")], {
      mutations: MutationSet.fixed(),
    });
    const note = describeInconclusive(inconclusiveBreakdown(suite.journeys)) ?? "";

    expect(note).toContain("the fault it depends on was never applied");
    expect(note).toContain("tool budget");
    expect(note).toContain("2 journey(s)");
  });

  /**
   * Returns null rather than an empty explanation, because a paragraph explaining nothing
   * is how the fixed sentence survived: it rendered whenever the count was non-zero and
   * never had to be true of any particular journey.
   */
  it("says nothing at all when nothing was inconclusive", async () => {
    const suite = await runSuite(REGRESSION_SCENARIOS.slice(0, 2), {
      mutations: MutationSet.fixed(),
    });
    const breakdown = inconclusiveBreakdown(suite.journeys);

    expect(breakdown.total).toBe(0);
    expect(describeInconclusive(breakdown)).toBeNull();
  });
});

describe("money at risk is split by whether anything actually stopped it", () => {
  /**
   * The headline read "At risk, prevented ₹14,744.29" beside "8 unsafe violations". An
   * unsafe violation is by definition a journey the Guard did not stop, so ₹4,609.29 of
   * that total — 31% — was money that got through, reported as money saved. The route's
   * own comments reject real payments for inflating this same figure by 43%, which is how
   * clearly the number was understood to matter.
   */
  it("never counts an unsafe violation's money as prevented", async () => {
    const suite = await runSuite(REGRESSION_SCENARIOS, {
      mutations: MutationSet.vulnerable(),
    });

    expect(suite.unsafeViolations).toBeGreaterThan(0);

    const escaped = suite.journeys
      .filter((j) => j.disposition === "unsafe_violation")
      .reduce((sum, j) => sum + j.moneyAtRiskMinor, 0);

    expect(escaped).toBeGreaterThan(0);
    expect(suite.moneyNotPreventedMinor).toBe(escaped);
    expect(suite.moneyPreventedMinor).toBe(suite.moneyAtRiskMinor - escaped);
    // The old label's claim, now false by construction.
    expect(suite.moneyPreventedMinor).toBeLessThan(suite.moneyAtRiskMinor);
  });

  it("still adds up to the total, so no money goes missing from the report", async () => {
    for (const mutations of [MutationSet.vulnerable(), MutationSet.fixed()]) {
      const suite = await runSuite(REGRESSION_SCENARIOS, { mutations });

      expect(suite.moneyPreventedMinor + suite.moneyNotPreventedMinor).toBe(
        suite.moneyAtRiskMinor,
      );
    }
  });

  it("attributes everything to prevented on a clean run", async () => {
    const suite = await runSuite(REGRESSION_SCENARIOS, {
      mutations: MutationSet.fixed(),
    });

    expect(suite.unsafeViolations).toBe(0);
    expect(suite.moneyNotPreventedMinor).toBe(0);
    expect(suite.moneyPreventedMinor).toBe(suite.moneyAtRiskMinor);
  });
});

describe("the readiness verdict shows the number it was decided by", () => {
  /**
   * READY and INCONCLUSIVE differ on exactly one quantity, and no surface printed it. A
   * reader could see a green tick and had no way to tell whether it rested on eleven
   * journeys of evidence or on the threshold being missed by one.
   */
  it("reports the same count the verdict is computed from", async () => {
    const suite = await runSuite(REGRESSION_SCENARIOS, {
      mutations: MutationSet.fixed(),
    });

    expect(suite.decidedJourneys).toBe(countDecided(suite.journeys));
    expect(suite.decidedJourneys).toBe(
      suite.journeys.filter((j) => j.exercisedInvariants.length > 0).length,
    );
  });

  it("agrees with the verdict it produced", async () => {
    const suite = await runSuite(REGRESSION_SCENARIOS, {
      mutations: MutationSet.fixed(),
    });

    // Clean, and above the half-of-journeys evidence bar, so READY is earned.
    expect(suite.unsafeViolations).toBe(0);
    expect(suite.decidedJourneys * 2).toBeGreaterThan(suite.journeys.length);
    expect(suite.readiness).toBe("READY FOR CONTROLLED TEST");
  });

  it("falls to INCONCLUSIVE when the evidence is not there, and the count shows why", async () => {
    const suite = await runSuite([agentStops("a-4"), agentStops("a-5")], {
      mutations: MutationSet.fixed(),
    });

    expect(suite.decidedJourneys).toBe(0);
    expect(suite.readiness).toBe("INCONCLUSIVE");
  });
});
