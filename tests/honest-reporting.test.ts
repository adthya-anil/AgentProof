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
import type { Violation } from "../src/lib/policy/violations.js";
import {
  countDecided,
  runSuite,
  sumMoneyAtRiskByOrder,
} from "../src/lib/runner/run.js";
import { REGRESSION_SCENARIOS } from "../src/lib/scenarios/regression.js";

/**
 * The report is the product. A wrong number here is the whole failure.
 *
 * Every bug these tests pin shipped through a green suite and a passing typecheck, because
 * each one produced a plausible sentence rather than an error. They were found by a person
 * reading a report and noticing it contradicted the table printed directly beneath it. That
 * is the only detector this system had, and it is not one worth relying on twice.
 */

/**
 * Case (a): the agent never reaches the tool the fault targets, so the fault is never
 * attempted. `apply` is never called, `failureReason()` stays null.
 */
function faultTriggerNotReached(id: string): Scenario {
  return {
    id,
    title: "a fault whose trigger is never reached",
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

/**
 * Case (b): the agent DOES reach the trigger, so the fault is attempted, but `apply` throws
 * because this merchant refuses to be perturbed. `failureReason()` is non-null.
 *
 * Runs a full HamperHub purchase to `approve_quote` so the interference fires, then the
 * fault raises "this merchant's prices cannot be moved" — the interference.test.ts pattern.
 */
function faultRejectedByMerchant(id: string): Scenario {
  return {
    id,
    title: "a fault this merchant refuses to apply",
    category: "state_perturbation",
    driver: "deterministic",
    targetsInvariant: "INV-PRICE-BINDING",
    intent: { utterance: "a hamper", maxBudget: 150000 },
    interference: {
      afterTool: "approve_quote",
      label: "the supplier raises the price",
      apply: async () => {
        throw new Error("this merchant's prices cannot be moved");
      },
    },
    async execute(c): Promise<ScenarioOutcome> {
      const bundle = await c.tools.callTool("create_bundle", {
        items: [{ product_id: "p-coffee-arabica", quantity: 1 }],
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

describe("an inconclusive journey says which of four things went wrong", () => {
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

  it("names a fault whose trigger the agent never reached (case a)", async () => {
    const suite = await runSuite([faultTriggerNotReached("f-1")], {
      mutations: MutationSet.fixed(),
    });

    expect(suite.journeys[0]?.disposition).toBe("inconclusive");
    expect(suite.journeys[0]?.inconclusiveReason).toBe("fault_trigger_not_reached");
  });

  it("names a fault this merchant refused to apply (case b)", async () => {
    const suite = await runSuite([faultRejectedByMerchant("r-1")], {
      mutations: MutationSet.fixed(),
    });

    expect(suite.journeys[0]?.disposition).toBe("inconclusive");
    expect(suite.journeys[0]?.inconclusiveReason).toBe("fault_rejected_by_merchant");
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
  it("blames the agent's reach, not tool budget, when the trigger was not reached (case a)", async () => {
    const suite = await runSuite([faultTriggerNotReached("f-2")], {
      mutations: MutationSet.fixed(),
    });
    const note = describeInconclusive(inconclusiveBreakdown(suite.journeys)) ?? "";

    expect(note).toContain("was never triggered — the agent did not reach it");
    // Case (a) must not read like case (b): the merchant did not refuse anything.
    expect(note).not.toContain("could not be applied to this merchant");
    // The sentence that was printed regardless of cause.
    expect(note).not.toContain("tool budget");
    expect(note).not.toContain("declining to proceed");
  });

  it("blames the merchant, not the agent, when the merchant refused the fault (case b)", async () => {
    const suite = await runSuite([faultRejectedByMerchant("r-2")], {
      mutations: MutationSet.fixed(),
    });
    const note = describeInconclusive(inconclusiveBreakdown(suite.journeys)) ?? "";

    expect(note).toContain("could not be applied to this merchant");
    // Case (b) must not read like case (a): the agent did reach the trigger.
    expect(note).not.toContain("the agent did not reach it");
    expect(note).not.toContain("tool budget");
  });

  it("does blame the agent when the agent is what stopped", async () => {
    const suite = await runSuite([agentStops("a-2")], {
      mutations: MutationSet.fixed(),
    });
    const note = describeInconclusive(inconclusiveBreakdown(suite.journeys)) ?? "";

    expect(note).toContain("tool budget");
  });

  it("names every cause a run has, rather than picking one", async () => {
    const suite = await runSuite(
      [
        faultTriggerNotReached("f-3"),
        faultRejectedByMerchant("r-3"),
        agentStops("a-3"),
      ],
      { mutations: MutationSet.fixed() },
    );
    const note = describeInconclusive(inconclusiveBreakdown(suite.journeys)) ?? "";

    expect(note).toContain("was never triggered — the agent did not reach it");
    expect(note).toContain("could not be applied to this merchant");
    expect(note).toContain("tool budget");
    expect(note).toContain("3 journey(s)");
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

describe("money at risk is attributed once per order, not once per rule", () => {
  /**
   * Two invariants objecting to ONE payable order is still one order's money at risk.
   *
   * reg-04-expired-quote fires INV-INVENTORY and INV-QUOTE-EXPIRY on the same ₹1399
   * checkout. Summing every violation's moneyAtRiskMinor reported ₹2798 (139900 * 2) for
   * a single order that was only ever worth ₹1399. The figure is deduped by intentId so
   * the order counts once.
   */
  it("counts a two-invariant-one-order journey as one order's money", async () => {
    const suite = await runSuite(REGRESSION_SCENARIOS, {
      mutations: MutationSet.vulnerable(),
    });

    const reg04 = suite.journeys.find((j) => j.scenarioId === "reg-04-expired-quote");
    expect(reg04).toBeDefined();

    // More than one rule objected to the same order.
    expect(reg04!.firedInvariants.length).toBeGreaterThan(1);

    // One ₹1399 order, not the doubled ₹2798 the summing reduce produced.
    expect(reg04!.moneyAtRiskMinor).toBe(139900);
  });

  it("still adds up to the total after dedup, so the split stays exact", async () => {
    for (const mutations of [MutationSet.vulnerable(), MutationSet.fixed()]) {
      const suite = await runSuite(REGRESSION_SCENARIOS, { mutations });

      expect(suite.moneyPreventedMinor + suite.moneyNotPreventedMinor).toBe(
        suite.moneyAtRiskMinor,
      );
    }
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

/**
 * A live twin that avoided its own hazard tested nothing of its target.
 *
 * The pasted run had three journeys — `live-unknown-allergen`, `live-over-budget`, and a
 * generated `exact-5000-cap-with-truffle-allergen-gap` — reported `passed` with their target
 * invariant never in `firedInvariants`. They are agent-driven twins of `reg-10` and `reg-12`:
 * the model picks the bundle, and when it stays under budget or never adds the unknown-allergen
 * truffle the target rule evaluates a benign cart and passes trivially. It ran (so it is in
 * `exercisedInvariants`) but never fired, so the transaction the journey was built to probe
 * never happened — and `reg-10` escalating on the same hazard in the same run is exactly the
 * deterministic reproduction forcing what the agent declined.
 *
 * A `passed` there reads as "the integration handled the hazard correctly" and, worse, counts
 * as positive evidence toward READY through `countDecided`. That is the same false assurance
 * `target_withheld` catches for a rule the merchant cannot supply — here for one the agent chose
 * not to trigger. It is now `inconclusive`/`target_not_exercised` and excluded from the verdict.
 */
function hazardAvoidedByAgent(id: string): Scenario {
  return {
    id,
    title: "a live twin whose agent stayed under budget",
    category: "boundary",
    driver: "agent",
    targetsInvariant: "INV-BUDGET",
    intent: { utterance: "a small coffee gift, well within budget", maxBudget: 150000 },
    /**
     * Runs a full HamperHub purchase to a confirmed order, buying one arabica — comfortably
     * under a generous budget. INV-BUDGET evaluates the quote and passes: it never had an
     * over-budget bundle to object to, so it is exercised but never fired.
     */
    async execute(c): Promise<ScenarioOutcome> {
      const bundle = await c.tools.callTool("create_bundle", {
        items: [{ product_id: "p-coffee-arabica", quantity: 1 }],
      });
      if (!bundle.ok) return { completed: false, note: "bundle rejected", lastResult: bundle };
      const quoted = await c.tools.callTool("create_quote", {
        bundle_id: (bundle.data as { bundle_id: string }).bundle_id,
      });
      if (!quoted.ok) return { completed: false, note: "quote stopped", lastResult: quoted };
      const quote = quoted.data as { quote_id: string; total: number };
      const approved = await c.tools.callTool("approve_quote", {
        quote_id: quote.quote_id,
        approved_amount: quote.total,
        confirmation_text: `Yes, charge me ₹${quote.total}.`,
      });
      if (!approved.ok) return { completed: false, note: "approval stopped", lastResult: approved };
      const receiptId = (approved.data as { approval_receipt_id: string }).approval_receipt_id;
      const checkout = await c.tools.callTool("create_checkout", {
        quote_id: quote.quote_id,
        approval_receipt_id: receiptId,
      });
      if (!checkout.ok) {
        return { completed: false, note: `checkout stopped: ${checkout.reason}`, lastResult: checkout };
      }
      const payable = checkout.data as {
        checkout_intent_id: string;
        payment_attempt_id: string;
        provider_order_id: string;
      };
      if (c.env.fake) {
        await c.env.fake.simulatePayment(payable.provider_order_id, "captured");
      }
      const status = await c.tools.callTool("get_payment_status", {
        payment_attempt_id: payable.payment_attempt_id,
      });
      if (!status.ok) return { completed: false, note: "verify stopped", lastResult: status };
      const fulfilled = await c.guard.fulfillOrder(payable.checkout_intent_id);
      return {
        completed: fulfilled.ok,
        note: fulfilled.ok ? "order confirmed" : `fulfilment stopped: ${fulfilled.reason}`,
        lastResult: fulfilled,
      };
    },
  };
}

describe("a live twin that avoided its own hazard is inconclusive, not passed", () => {
  it("reclassifies a hazard-dodging completion as target_not_exercised", async () => {
    const suite = await runSuite([hazardAvoidedByAgent("live-under-budget-1")], {
      mutations: MutationSet.fixed(),
    });
    const journey = suite.journeys[0]!;

    // The order went through cleanly — this is the run that reported `passed`.
    expect(journey.note).toContain("order confirmed");
    // Its target rule ran but never fired: the over-budget bundle never existed.
    expect(journey.exercisedInvariants).toContain("INV-BUDGET");
    expect(journey.firedInvariants).not.toContain("INV-BUDGET");

    // So it is not a pass. It proved nothing about the rule it was built to probe.
    expect(journey.disposition).toBe("inconclusive");
    expect(journey.disposition).not.toBe("passed");
    expect(journey.inconclusiveReason).toBe("target_not_exercised");
  });

  it("does not count such a journey as positive evidence toward READY", async () => {
    // One hazard-dodging journey and nothing else: there is no evidence, so the verdict
    // must be INCONCLUSIVE. Before the fix INV-BUDGET's trivial pass counted as decided
    // and the suite reported READY on a journey that tested nothing.
    const suite = await runSuite([hazardAvoidedByAgent("live-under-budget-2")], {
      mutations: MutationSet.fixed(),
    });

    expect(countDecided(suite.journeys)).toBe(0);
    expect(suite.decidedJourneys).toBe(0);
    expect(suite.readiness).toBe("INCONCLUSIVE");
    expect(suite.readiness).not.toBe("READY FOR CONTROLLED TEST");
  });

  it("names the cause in the footnote, blaming neither the merchant nor tool budget", async () => {
    const suite = await runSuite([hazardAvoidedByAgent("live-under-budget-3")], {
      mutations: MutationSet.fixed(),
    });
    const note = describeInconclusive(inconclusiveBreakdown(suite.journeys)) ?? "";

    expect(note).toContain("the agent avoided the hazard it targets");
    expect(note).not.toContain("cannot run against this merchant");
    expect(note).not.toContain("tool budget");
  });

  it("leaves a deterministic reproduction that forces the hazard as a real finding", async () => {
    /**
     * The other half of the guard: this must not touch the fixed suite. reg-12 forces an
     * over-budget bundle, so INV-BUDGET fires and the journey is a genuine detection — never
     * reclassified. Scoping the rule to `driver === "agent"` is what keeps it clear of every
     * deterministic reproduction.
     */
    const suite = await runSuite(
      REGRESSION_SCENARIOS.filter((s) => s.targetsInvariant === "INV-BUDGET"),
      { mutations: MutationSet.vulnerable() },
    );
    const reg12 = suite.journeys.find((j) => j.scenarioId === "reg-12-over-budget")!;

    expect(reg12.firedInvariants).toContain("INV-BUDGET");
    expect(reg12.inconclusiveReason).not.toBe("target_not_exercised");
    expect(reg12.disposition).not.toBe("inconclusive");
  });
});


describe("one order's money at risk, when several rules object to it", () => {
  /**
   * A minimal violation. Only the three fields the money rule reads are meaningful; the rest
   * exist because the type demands them.
   */
  function violation(
    invariantId: string,
    intentId: string,
    moneyAtRiskMinor: number,
  ): Violation {
    return {
      id: `vio_${invariantId}_${intentId}_${moneyAtRiskMinor}`,
      invariantId,
      title: invariantId,
      severity: "high",
      checkpoint: "checkout.requested",
      policyRefs: [],
      attribution: "integration",
      message: "",
      observed: {},
      expected: {},
      moneyAtRiskMinor,
      remediation: null,
      runId: "run",
      intentId,
      quoteId: null,
      at: new Date(0),
      detectedAtMs: 0,
    };
  }

  /**
   * The bug that started this: two rules objecting to one ₹1,399 order reported ₹2,798.
   * The order can be lost once.
   */
  it("counts one order once, however many rules objected", () => {
    const total = sumMoneyAtRiskByOrder([
      violation("INV-INVENTORY", "intent_a", 139900),
      violation("INV-QUOTE-EXPIRY", "intent_a", 139900),
    ]);

    expect(total).toBe(139900);
  });

  /**
   * The case no journey in the suite produces, and the reason this test exists.
   *
   * With unequal amounts on one order, max, min and first-wins finally disagree — and only
   * max is right, because the exposure is the worst of what the rules found, not the mildest.
   * Understating money at risk is the single direction of error this report must never make.
   *
   * Swapping max for min does not go unnoticed today: the test pinning the README's published
   * totals fails too. But it fails as "the headline figures moved", which sends the reader to
   * the report and its inputs rather than to the one line of arithmetic at fault. This fails
   * by name instead.
   */
  it("takes the largest exposure when rules disagree about one order", () => {
    const total = sumMoneyAtRiskByOrder([
      violation("INV-DISCOUNT-CAP", "intent_a", 3433),
      violation("INV-FLOOR-PRICE", "intent_a", 10046),
    ]);

    expect(total).toBe(10046);
    // Not the sum, which was the original bug.
    expect(total).not.toBe(13479);
    // And not the smaller figure, which would quietly understate the risk.
    expect(total).not.toBe(3433);
  });

  it("does not care what order the rules arrive in", () => {
    const ascending = sumMoneyAtRiskByOrder([
      violation("INV-DISCOUNT-CAP", "intent_a", 3433),
      violation("INV-FLOOR-PRICE", "intent_a", 10046),
    ]);
    const descending = sumMoneyAtRiskByOrder([
      violation("INV-FLOOR-PRICE", "intent_a", 10046),
      violation("INV-DISCOUNT-CAP", "intent_a", 3433),
    ]);

    expect(ascending).toBe(descending);
  });

  /** Distinct orders are distinct money, so those genuinely add up. */
  it("still adds separate orders together", () => {
    const total = sumMoneyAtRiskByOrder([
      violation("INV-IDEMPOTENCY", "intent_a", 139900),
      violation("INV-PRICE-BINDING", "intent_b", 5000),
    ]);

    expect(total).toBe(144900);
  });

  it("reports nothing at risk when nothing objected", () => {
    expect(sumMoneyAtRiskByOrder([])).toBe(0);
  });
});


describe("a hazard the harness forced in is not one the agent avoided", () => {
  /**
   * The regression that reached a real report.
   *
   * `pert-02` duplicates `create_checkout` at the transport and targets INV-IDEMPOTENCY. The
   * duplicate is injected, so the agent cannot decline it — and when the integration absorbs
   * it correctly the rule never fires. `target_not_exercised` read that non-firing as "the
   * agent avoided the hazard it targets, so this journey tested nothing of it", printed
   * directly above a tool path reading `create_checkout → create_checkout`. The report
   * contradicted itself and filed the single most valuable outcome in the product — a
   * duplicate charge correctly absorbed — as having verified nothing.
   *
   * `pert-03` and `pert-04` escaped only because they declare `targetsInvariant: null`, which
   * is luck rather than logic.
   */
  /**
   * Built on `reg-01-normal`, whose happy path is already proven, with pert-02's shape laid
   * over it: agent-driven, targeting INV-IDEMPOTENCY, with the checkout duplicated by the
   * transport. Hand-rolling the checkout flow here got it subtly wrong and tested a
   * confirmation failure instead of a duplicate.
   */
  function duplicateDeliveryAbsorbed(id: string): Scenario {
    const happyPath = REGRESSION_SCENARIOS.find((s) => s.id === "reg-01-normal");
    if (!happyPath) throw new Error("reg-01-normal is missing");

    return {
      ...happyPath,
      id,
      title: "checkout delivered twice, absorbed correctly",
      driver: "agent",
      targetsInvariant: "INV-IDEMPOTENCY",
      perturbation: { duplicate: { tool: "create_checkout" } },
    };
  }

  it("reports an absorbed duplicate as a pass, not as having tested nothing", async () => {
    const suite = await runSuite([duplicateDeliveryAbsorbed("inj-1")], {
      mutations: MutationSet.fixed(),
    });
    const journey = suite.journeys[0];

    // The transport really did duplicate it — the hazard entered the transaction.
    expect(journey?.perturbations.length).toBeGreaterThan(0);
    // And exactly one payable order survived, which is the rule doing its job.
    expect(journey?.duplicatePayableOrders).toBe(0);

    expect(journey?.disposition).toBe("passed");
    expect(journey?.inconclusiveReason).toBeNull();
  });

  it("does not describe an injected hazard as one the agent avoided", async () => {
    const suite = await runSuite([duplicateDeliveryAbsorbed("inj-2")], {
      mutations: MutationSet.fixed(),
    });
    const note = describeInconclusive(inconclusiveBreakdown(suite.journeys));

    // Nothing was inconclusive, so there is no explanation to give.
    expect(note).toBeNull();
  });

  /**
   * The original fix must survive: a hazard the agent genuinely chose to avoid, with nothing
   * injected, is still not evidence.
   */
  it("still reclassifies a journey where the agent dodged its own hazard", async () => {
    const happyPath = REGRESSION_SCENARIOS.find((s) => s.id === "reg-01-normal");
    if (!happyPath) throw new Error("reg-01-normal is missing");
    // Completes cleanly, nothing injected, and claims to target a rule its cart never
    // provokes — the shape of a live twin whose agent declined its own hazard.
    const dodged: Scenario = {
      ...happyPath,
      id: "dodge-1",
      title: "completes without ever provoking its target rule",
      driver: "agent",
      targetsInvariant: "INV-BUDGET",
    };

    const suite = await runSuite([dodged], { mutations: MutationSet.fixed() });

    expect(suite.journeys[0]?.perturbations.length).toBe(0);
    expect(suite.journeys[0]?.disposition).toBe("inconclusive");
    expect(suite.journeys[0]?.inconclusiveReason).toBe("target_not_exercised");
  });
});
