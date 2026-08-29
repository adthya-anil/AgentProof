import { describe, expect, it } from "vitest";
import { MutationSet } from "../src/lib/hamperhub/mutations.js";
import { runSuite } from "../src/lib/runner/run.js";
import { contestedProduct } from "../src/lib/scenarios/regression.js";
import type {
  Scenario,
  ScenarioContext,
  ScenarioOutcome,
} from "../src/lib/scenarios/types.js";

/**
 * Bug 2 (FEAT-003): a state-perturbation fault must land on the product the buyer actually
 * bought, not on a hardcoded shelf.
 *
 * The reg-08 stock-out named `p-coffee-arabica` outright. On HamperHub that product always
 * exists, so a live agent that bought something else had its shelf stocked out while the
 * agent's own reservation was untouched: INV-INVENTORY never fired and the journey reported
 * a clean `passed` against a rule it never exercised. `live-inventory-changed` passed three
 * runs out of three that way, beside reg-08 safely-rejecting the identical fault.
 *
 * The fix inverts `contestedProduct`: perturb the product in the buyer's most-recent quote
 * first, fall back to the named product only when the quote yields nothing usable. These
 * tests pin that a non-arabica buyer is genuinely tested, and bite if the old order returns.
 */

/**
 * A stock-out journey that buys `p-mug-ceramic` — a real HamperHub product that is NOT the
 * hardcoded arabica shelf — and stocks out whatever `contestedProduct` chooses, exactly as
 * reg-08 does. With the fix the fault lands on the mug the buyer reserved and INV-INVENTORY
 * fires; with the old order it lands on arabica, nothing the buyer holds changes, and the
 * journey passes having proved nothing.
 */
function stockOutNonArabicaBuyer(id: string): Scenario {
  return {
    id,
    title: "stock-out targeting a buyer who did not buy arabica",
    category: "state_perturbation",
    driver: "deterministic",
    targetsInvariant: "INV-INVENTORY",
    intent: { utterance: "A single ceramic mug, please.", maxBudget: 1500 },
    interference: {
      afterTool: "approve_quote",
      label: "a stock-take reconciles the shelf to zero",
      apply: (env) => {
        const target = contestedProduct(env, "p-coffee-arabica");
        if (!target) {
          throw new Error(
            "no product in this buyer's order could be stocked out, so the stock-out " +
              "fault could not be applied",
          );
        }
        env.state.forceStockOut(
          target.productId,
          "Stock-take correction: shelf count reconciled to zero",
        );
        env.clock.advanceMinutes(1);
      },
    },
    async execute(c: ScenarioContext): Promise<ScenarioOutcome> {
      const bundle = await c.tools.callTool("create_bundle", {
        items: [{ product_id: "p-mug-ceramic", quantity: 1 }],
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
      const receipt = approved.data as { approval_receipt_id: string };

      const checkout = await c.tools.callTool("create_checkout", {
        quote_id: quote.quote_id,
        approval_receipt_id: receipt.approval_receipt_id,
      });
      if (!checkout.ok) {
        return { completed: false, note: "checkout stopped", lastResult: checkout };
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
      if (!status.ok) {
        return { completed: false, note: "verification stopped", lastResult: status };
      }
      const fulfilled = await c.guard.fulfillOrder(payable.checkout_intent_id);
      return {
        completed: fulfilled.ok,
        note: fulfilled.ok ? "order confirmed" : "fulfilment stopped",
        lastResult: fulfilled,
      };
    },
  };
}

describe("a state-perturbation fault follows the buyer, not a hardcoded shelf", () => {
  it("picks the product in the buyer's most-recent quote, not the named fallback", () => {
    /**
     * The unit-level statement of the fix. A buyer whose only quote is a mug must have the
     * mug chosen for perturbation, even though the named `p-coffee-arabica` exists in state.
     * The old order returned arabica here regardless of what was bought.
     */
    const scenario = stockOutNonArabicaBuyer("unit-1");
    let chosen: string | null = null;
    const spy: Scenario = {
      ...scenario,
      interference: {
        ...scenario.interference!,
        apply: (env) => {
          chosen = contestedProduct(env, "p-coffee-arabica")?.productId ?? null;
        },
      },
    };

    return runSuite([spy], { mutations: MutationSet.fixed() }).then(() => {
      expect(chosen).toBe("p-mug-ceramic");
      expect(chosen).not.toBe("p-coffee-arabica");
    });
  });

  it("does not pass a non-arabica buyer with the target invariant never firing", async () => {
    /**
     * The reported bug, at the journey level. The fault lands on the mug the buyer actually
     * reserved, so INV-INVENTORY has something to catch. The journey must NOT be a silent
     * `passed`: it either fires the target invariant or is inconclusive because the fault
     * could not be applied — never a clean pass against a rule it never exercised.
     *
     * With the old preference order (named product first) the stock-out hit arabica, the
     * buyer's mug reservation was untouched, INV-INVENTORY never fired, and this journey
     * came back `passed` with an empty `firedInvariants` — which is exactly what this
     * assertion rejects. Revert `contestedProduct` to name-first and this test fails.
     */
    const suite = await runSuite([stockOutNonArabicaBuyer("journey-1")], {
      mutations: MutationSet.fixed(),
    });
    const journey = suite.journeys[0]!;

    const silentPass =
      journey.disposition === "passed" &&
      !journey.firedInvariants.includes("INV-INVENTORY");
    expect(
      silentPass,
      `journey reported '${journey.disposition}' with firedInvariants ` +
        `[${journey.firedInvariants.join(", ")}] — a non-arabica buyer was not tested`,
    ).toBe(false);

    // Positively: the fault reached the buyer's own product, so the target rule fired.
    expect(journey.firedInvariants).toContain("INV-INVENTORY");
    expect(journey.disposition).not.toBe("passed");
  });
});
