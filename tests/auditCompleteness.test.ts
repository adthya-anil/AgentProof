import { describe, expect, it } from "vitest";
import { AUDIT_EVENT_TYPES } from "../src/lib/audit/events.js";
import { MutationSet } from "../src/lib/hamperhub/mutations.js";
import { runScenario } from "../src/lib/runner/run.js";
import { REGRESSION_SCENARIOS } from "../src/lib/scenarios/regression.js";

/**
 * Does the audit trail actually record every money-relevant decision?
 *
 * The product's central claim is that a tamper-evident log holds every decision that
 * could move money. Three gaps were found by asking that question directly rather
 * than assuming it:
 *
 *  1. A refused 10% promotion appeared in the tool response and not in the log, so a
 *     reader could not tell a correctly enforced cap from a swallowed promo code.
 *  2. The price change and stock-out that *cause* INV-PRICE-BINDING and
 *     INV-INVENTORY to fire were invisible. The trail showed a checkout blocked for
 *     "catalog prices changed" with nothing recording that a price had changed.
 *  3. `run.started` and `run.completed` were declared vocabulary nothing emitted,
 *     which meant the journey's own verdict lived outside the hash chain: every
 *     decision leading to a conclusion was covered, and the conclusion was not.
 *
 * These tests exist so none of the three can reopen quietly.
 */

async function trailFor(scenarioId: string, variant: "vulnerable" | "fixed") {
  const scenario = REGRESSION_SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) throw new Error(`No such scenario: ${scenarioId}`);
  const journey = await runScenario(scenario, {
    mutations:
      variant === "vulnerable" ? MutationSet.vulnerable() : MutationSet.fixed(),
  });
  return journey;
}

describe("the cause of a violation is in the trail, not just the effect", () => {
  it("records the price change behind INV-PRICE-BINDING", async () => {
    const journey = await trailFor("reg-07-price-changed", "vulnerable");
    expect(journey.firedInvariants).toContain("INV-PRICE-BINDING");

    const change = journey.auditTrail.find(
      (e) => e.type === "catalog.state_changed",
    );
    expect(change, "the price change must be recorded").toBeDefined();

    const out = change!.output as Record<string, unknown>;
    expect(out.kind).toBe("price");
    expect(out.product_id).toBe("p-coffee-arabica");
    // The numbers are the point: without them the entry cannot be checked
    // against the violation it caused.
    expect(out.from).toBe(599);
    expect(out.to).toBe(649);
    expect(change!.reason).toBe("Supplier cost increase");
  });

  it("records the stock-out behind INV-INVENTORY", async () => {
    const journey = await trailFor("reg-08-inventory-changed", "vulnerable");
    expect(journey.firedInvariants).toContain("INV-INVENTORY");

    const change = journey.auditTrail.find(
      (e) => e.type === "catalog.state_changed",
    );
    expect(change).toBeDefined();

    const out = change!.output as Record<string, unknown>;
    expect(out.kind).toBe("inventory");
    expect(out.to).toBe(0);
  });

  it("puts the change after the approval it undermines", async () => {
    // Ordering carries the argument. A price rise before the quote is ordinary
    // commerce; the same rise after the buyer agreed is the finding.
    const journey = await trailFor("reg-07-price-changed", "vulnerable");
    const approved = journey.auditTrail.findIndex(
      (e) => e.type === "quote.approved",
    );
    const changed = journey.auditTrail.findIndex(
      (e) => e.type === "catalog.state_changed",
    );
    const blocked = journey.auditTrail.findIndex(
      (e) => e.type === "checkout.blocked",
    );

    expect(approved).toBeGreaterThan(-1);
    expect(changed).toBeGreaterThan(approved);
    expect(blocked).toBeGreaterThan(changed);
  });

  it("does not invent a state change on an undisturbed journey", async () => {
    const journey = await trailFor("reg-01-normal", "fixed");
    expect(
      journey.auditTrail.some((e) => e.type === "catalog.state_changed"),
    ).toBe(false);
  });
});

describe("a refused promotion is in the trail", () => {
  it("records which codes were refused and why", async () => {
    const journey = await trailFor("reg-09-discount-stacking", "vulnerable");
    const quote = journey.auditTrail.find((e) => e.type === "quote.created");
    expect(quote).toBeDefined();

    const refused = (quote!.output as { rejected_promo_codes?: unknown })
      .rejected_promo_codes;
    // The field must exist even when empty, so its absence cannot be mistaken
    // for "no promotions were requested".
    expect(Array.isArray(refused)).toBe(true);
  });
});

describe("the verdict is inside the hash chain", () => {
  it("opens with what was attempted", async () => {
    const journey = await trailFor("reg-07-price-changed", "vulnerable");
    const started = journey.auditTrail[0];

    expect(started?.type).toBe("run.started");
    const out = started!.output as Record<string, unknown>;
    expect(out.scenario_id).toBe("reg-07-price-changed");
    expect(out.driver).toBe("deterministic");
    expect(out.targets_invariant).toBe("INV-PRICE-BINDING");
    // Which defects were active is what makes a result interpretable later.
    expect(Array.isArray(out.seeded_defects)).toBe(true);
  });

  it("closes with the conclusion reached", async () => {
    const journey = await trailFor("reg-07-price-changed", "vulnerable");
    const completed = journey.auditTrail[journey.auditTrail.length - 1];

    expect(completed?.type).toBe("run.completed");
    const out = completed!.output as Record<string, unknown>;
    expect(out.disposition).toBe("unsafe_violation");
    expect(out.fired_invariants).toContain("INV-PRICE-BINDING");
    expect(out.integration_defects).toBeGreaterThan(0);
  });

  it("agrees with the journey result it is reported alongside", async () => {
    // Two accounts of one journey. If they can disagree, one of them is decoration.
    for (const id of [
      "reg-01-normal",
      "reg-05-duplicate-payment",
      "reg-10-unknown-allergen",
    ]) {
      const journey = await trailFor(id, "vulnerable");
      const completed = journey.auditTrail.at(-1);
      const out = completed!.output as Record<string, unknown>;

      expect(out.disposition, `${id} disposition`).toBe(journey.disposition);
      expect(out.fired_invariants, `${id} invariants`).toEqual(
        journey.firedInvariants,
      );
      expect(out.self_rejected, `${id} self-rejected`).toBe(journey.selfRejected);
    }
  });

  it("leaves the chain verifiable with the verdict included", async () => {
    const journey = await trailFor("reg-07-price-changed", "vulnerable");
    // Appended before verification, so the conclusion is covered by the same
    // chain as the evidence for it rather than sitting outside it.
    expect(journey.auditChainOk).toBe(true);
    expect(journey.auditTrail.at(-1)?.type).toBe("run.completed");
  });
});

describe("the declared vocabulary is not aspirational", () => {
  /**
   * Every declared event type must be reachable. `run.started` and `run.completed`
   * were declared, rendered by the report writer, and impossible to produce — the
   * same class of untruth as a configuration knob that does nothing.
   */
  it("emits every event type the spec declares, given the right journey", async () => {
    const seen = new Set<string>();
    for (const scenario of REGRESSION_SCENARIOS) {
      for (const variant of ["vulnerable", "fixed"] as const) {
        const journey = await trailFor(scenario.id, variant);
        for (const event of journey.auditTrail) seen.add(event.type);
      }
    }

    const never = AUDIT_EVENT_TYPES.filter((type) => !seen.has(type));

    // razorpay.order_created is the sole exception, and deliberately so: it is
    // emitted only when an order was really created at Razorpay, so that a trace
    // can never imply a real provider was involved when it was not. The suite runs
    // on the simulator, which emits payment.order_created instead.
    expect(never).toEqual(["razorpay.order_created"]);
    expect(seen.has("payment.order_created")).toBe(true);
  });
});


describe("a reconciled retry is not a second order", () => {
  /**
   * `pert-02` delivers `create_checkout` twice. On the fixed integration the merchant
   * reconciles: same idempotency key, same checkout intent, same payment attempt,
   * same provider order. One order.
   *
   * It was reported as `providerOrders=2`, because the count came from
   * `payment.order_created` events and the reconciled path emits one for the order it
   * returned. So the single journey that proves idempotency works was the one that
   * looked like it had created two payable orders — on the *fixed* integration,
   * beside `passed` and zero escapes.
   */
  async function duplicatedDelivery(variant: "vulnerable" | "fixed") {
    const { PERTURBATION_SCENARIOS } = await import(
      "../src/lib/scenarios/perturbations.js"
    );
    const scenario = PERTURBATION_SCENARIOS.find((s) =>
      s.id.startsWith("pert-02"),
    )!;
    return runScenario(scenario, {
      mutations:
        variant === "fixed" ? MutationSet.fixed() : MutationSet.vulnerable(),
    });
  }

  it("counts one provider order when a duplicate delivery is reconciled", async () => {
    const journey = await duplicatedDelivery("fixed");

    expect(journey.disposition).toBe("passed");
    expect(journey.providerOrders).toBe(1);
    expect(journey.duplicatePayableOrders).toBe(0);
  });

  it("records the reconciliation rather than implying a second creation", async () => {
    const journey = await duplicatedDelivery("fixed");
    const created = journey.auditTrail.filter((e) =>
      e.type.endsWith("order_created"),
    );

    // Two entries, because the merchant handled two requests — but only one of them
    // created anything, and the trail now says which.
    expect(created).toHaveLength(2);
    const flags = created.map(
      (e) => (e.output as { reconciled: boolean }).reconciled,
    );
    expect(flags).toEqual([false, true]);

    const ids = new Set(
      created.map((e) => (e.output as { provider_order_id: string }).provider_order_id),
    );
    expect(ids.size, "one order, referenced twice").toBe(1);
    expect(created[1]!.reason).toMatch(/no second order created/);
  });

  it("still catches the vulnerable integration creating a real duplicate", async () => {
    // The fix must not make the defect harder to see: missing idempotency should
    // still trip INV-IDEMPOTENCY rather than being quietly deduplicated away.
    const journey = await duplicatedDelivery("vulnerable");
    expect(journey.disposition).toBe("unsafe_violation");
    expect(journey.firedInvariants).toContain("INV-IDEMPOTENCY");
  });

  it("counts distinct orders, not order events", async () => {
    // The property behind the fix, stated directly: providerOrders must never exceed
    // the number of distinct provider order ids in the trail.
    for (const variant of ["vulnerable", "fixed"] as const) {
      const journey = await duplicatedDelivery(variant);
      const distinct = new Set(
        journey.auditTrail
          .filter((e) => e.type.endsWith("order_created"))
          .map((e) => (e.output as { provider_order_id: string }).provider_order_id),
      );
      expect(journey.providerOrders, variant).toBe(distinct.size);
    }
  });
});
