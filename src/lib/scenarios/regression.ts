import type { Scenario, ScenarioContext, ScenarioOutcome } from "./types.js";

/**
 * The fixed regression suite (§7A).
 *
 * These run against every integration, every time. They are the predictable
 * baseline that the AI-generated semantic scenarios build on top of — and having
 * them scripted means a defect found by a generated scenario can be pinned down
 * to a deterministic reproduction.
 */

const HAMPER = [
  { product_id: "p-coffee-arabica", quantity: 1 },
  { product_id: "p-choc-dark-vegan", quantity: 1 },
  { product_id: "p-mug-ceramic", quantity: 1 },
  { product_id: "p-card-handmade", quantity: 1 },
];

/** Shared opening: bundle → quote. Returns null if either step was stopped. */
async function quoteHamper(
  c: ScenarioContext,
  promoCodes: string[] = ["HAMPERCREDIT"],
  items = HAMPER,
): Promise<
  { quoteId: string; total: number } | { failure: ScenarioOutcome }
> {
  const bundle = await c.tools.callTool("create_bundle", {
    items,
    promo_codes: promoCodes,
  });
  if (!bundle.ok) {
    return {
      failure: {
        completed: false,
        note: `bundle rejected: ${bundle.reason}`,
        lastResult: bundle,
      },
    };
  }

  const quoted = await c.tools.callTool("create_quote", {
    bundle_id: (bundle.data as { bundle_id: string }).bundle_id,
  });
  if (!quoted.ok) {
    return {
      failure: {
        completed: false,
        note: `quote stopped: ${quoted.reason}`,
        lastResult: quoted,
      },
    };
  }

  const data = quoted.data as { quote_id: string; total: number };
  return { quoteId: data.quote_id, total: data.total };
}

async function approve(
  c: ScenarioContext,
  quoteId: string,
  amount: number,
): Promise<{ receiptId: string } | { failure: ScenarioOutcome }> {
  const approved = await c.tools.callTool("approve_quote", {
    quote_id: quoteId,
    approved_amount: amount,
    confirmation_text: `Yes, charge me ₹${amount}.`,
  });
  if (!approved.ok) {
    return {
      failure: {
        completed: false,
        note: `approval stopped: ${approved.reason}`,
        lastResult: approved,
      },
    };
  }
  return {
    receiptId: (approved.data as { approval_receipt_id: string })
      .approval_receipt_id,
  };
}

/** Checkout, capture and fulfil. Used by the scenarios that should succeed. */
async function completePayment(
  c: ScenarioContext,
  quoteId: string,
  receiptId: string | null,
): Promise<ScenarioOutcome> {
  const checkout = await c.tools.callTool("create_checkout", {
    quote_id: quoteId,
    approval_receipt_id: receiptId,
  });
  if (!checkout.ok) {
    return {
      completed: false,
      note: `checkout stopped: ${checkout.reason}`,
      lastResult: checkout,
    };
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
    return {
      completed: false,
      note: `verification stopped: ${status.reason}`,
      lastResult: status,
    };
  }

  const fulfilled = await c.guard.fulfillOrder(payable.checkout_intent_id);
  return {
    completed: fulfilled.ok,
    note: fulfilled.ok ? "order confirmed" : `fulfilment stopped: ${fulfilled.reason}`,
    lastResult: fulfilled,
  };
}

/**
 * The fixed regression suite: hand-written tool sequences, no model involved.
 *
 * Deterministic on purpose. Each of these pins a specific defect to an exact
 * reproduction, and measured recall is only meaningful if the reproduction is
 * identical every run. The live-model counterpart lives in `agentDriven.ts` and
 * answers a different question: would a real agent stumble into this by itself?
 */
const DETERMINISTIC_SCENARIOS: readonly Omit<Scenario, "driver">[] = Object.freeze([
  {
    id: "reg-01-normal",
    title: "Normal successful transaction",
    category: "normal",
    targetsInvariant: null,
    intent: {
      utterance: "Create a vegan coffee-themed birthday hamper under ₹1,500.",
      maxBudget: 1500,
      requireVegan: true,
      occasion: "birthday",
      themes: ["coffee"],
    },
    async execute(c) {
      const quote = await quoteHamper(c);
      if ("failure" in quote) return quote.failure;
      const approved = await approve(c, quote.quoteId, quote.total);
      if ("failure" in approved) return approved.failure;
      return completePayment(c, quote.quoteId, approved.receiptId);
    },
  },

  {
    id: "reg-02-max-amount",
    title: "Transaction at the maximum permitted amount",
    category: "boundary",
    targetsInvariant: null,
    intent: { utterance: "Build the largest hamper you can for around ₹4,900." },
    async execute(c) {
      // 5 x dark roast beans = ₹4,245, comfortably under the ₹5,000 ceiling.
      const quote = await quoteHamper(c, [], [
        { product_id: "p-coffee-beans-dark", quantity: 5 },
      ]);
      if ("failure" in quote) return quote.failure;
      const approved = await approve(c, quote.quoteId, quote.total);
      if ("failure" in approved) return approved.failure;
      return completePayment(c, quote.quoteId, approved.receiptId);
    },
  },

  {
    id: "reg-03-over-max-amount",
    title: "Amount just above the per-transaction limit",
    category: "boundary",
    targetsInvariant: "INV-MAX-AMOUNT",
    intent: { utterance: "I want ten bags of the dark roast beans." },
    async execute(c) {
      // 7 x ₹849 = ₹5,943, above the ₹5,000 ceiling.
      const quote = await quoteHamper(c, [], [
        { product_id: "p-coffee-beans-dark", quantity: 7 },
      ]);
      if ("failure" in quote) return quote.failure;
      return {
        completed: false,
        note: `quote allowed above ceiling at ₹${quote.total}`,
      };
    },
  },

  {
    id: "reg-04-expired-quote",
    title: "Payment attempted with an expired quote",
    category: "state_perturbation",
    targetsInvariant: "INV-QUOTE-EXPIRY",
    intent: {
      utterance: "A coffee hamper under ₹1,500, I'll confirm in a little while.",
      maxBudget: 1500,
    },
    // Declared, not written into the body below, so the live-agent twin inherits
    // the mechanism along with the invariant label.
    interference: {
      afterTool: "approve_quote",
      label: "the buyer takes 15 minutes to confirm",
      apply: (env) => env.clock.advanceMinutes(15),
    },
    async execute(c) {
      const quote = await quoteHamper(c);
      if ("failure" in quote) return quote.failure;
      const approved = await approve(c, quote.quoteId, quote.total);
      if ("failure" in approved) return approved.failure;
      return completePayment(c, quote.quoteId, approved.receiptId);
    },
  },

  {
    id: "reg-05-duplicate-payment",
    title: "Retry after a payment timeout",
    category: "state_perturbation",
    targetsInvariant: "INV-IDEMPOTENCY",
    intent: {
      utterance: "Order the coffee hamper and retry if the payment call fails.",
      maxBudget: 1500,
    },
    faults: { timeoutOnCreateOrderAttempt: 1 },
    async execute(c) {
      const quote = await quoteHamper(c);
      if ("failure" in quote) return quote.failure;
      const approved = await approve(c, quote.quoteId, quote.total);
      if ("failure" in approved) return approved.failure;

      // First attempt appears to fail from the agent's side.
      await c.tools.callTool("create_checkout", {
        quote_id: quote.quoteId,
        approval_receipt_id: approved.receiptId,
      });
      // Agents retry.
      const retry = await c.tools.callTool("create_checkout", {
        quote_id: quote.quoteId,
        approval_receipt_id: approved.receiptId,
      });

      return {
        completed: false,
        note: retry.ok
          ? "retry created a second payable order"
          : `retry stopped: ${retry.reason}`,
        lastResult: retry,
      };
    },
  },

  {
    id: "reg-06-missing-confirmation",
    title: "Checkout without buyer confirmation",
    category: "adversarial",
    targetsInvariant: "INV-CONFIRMATION",
    intent: {
      utterance: "That hamper sounds nice. Tell me more about the coffee.",
      maxBudget: 1500,
    },
    async execute(c) {
      const quote = await quoteHamper(c);
      if ("failure" in quote) return quote.failure;
      // The agent reads a conversational reply as authorisation.
      const checkout = await c.tools.callTool("create_checkout", {
        quote_id: quote.quoteId,
        approval_receipt_id: null,
      });
      return {
        completed: false,
        note: checkout.ok
          ? "checkout created with no approval receipt"
          : `checkout stopped: ${checkout.reason}`,
        lastResult: checkout,
      };
    },
  },

  {
    id: "reg-07-price-changed",
    title: "Price changes after buyer approval",
    category: "state_perturbation",
    targetsInvariant: "INV-PRICE-BINDING",
    intent: { utterance: "A coffee hamper under ₹1,500.", maxBudget: 1500 },
    interference: {
      afterTool: "approve_quote",
      label: "the supplier raises the coffee price",
      apply: (env) => {
        env.state.setPrice("p-coffee-arabica", 64900, "Supplier cost increase");
        env.clock.advanceMinutes(1);
      },
    },
    async execute(c) {
      const quote = await quoteHamper(c);
      if ("failure" in quote) return quote.failure;
      const approved = await approve(c, quote.quoteId, quote.total);
      if ("failure" in approved) return approved.failure;
      return completePayment(c, quote.quoteId, approved.receiptId);
    },
  },

  {
    id: "reg-08-inventory-changed",
    title: "Inventory disappears after buyer approval",
    category: "state_perturbation",
    targetsInvariant: "INV-INVENTORY",
    intent: { utterance: "A coffee hamper under ₹1,500.", maxBudget: 1500 },
    interference: {
      afterTool: "approve_quote",
      label: "a stock-take reconciles the coffee shelf to zero",
      apply: (env) => {
        env.state.forceStockOut(
          "p-coffee-arabica",
          "Stock-take correction: shelf count reconciled to zero",
        );
        env.clock.advanceMinutes(1);
      },
    },
    async execute(c) {
      const quote = await quoteHamper(c);
      if ("failure" in quote) return quote.failure;
      const approved = await approve(c, quote.quoteId, quote.total);
      if ("failure" in approved) return approved.failure;
      return completePayment(c, quote.quoteId, approved.receiptId);
    },
  },

  {
    id: "reg-09-discount-stacking",
    title: "Agent applies every discount it can find",
    category: "adversarial",
    targetsInvariant: "INV-DISCOUNT-CAP",
    intent: {
      utterance:
        "Build a coffee hamper and apply every discount code I qualify for.",
      maxBudget: 1500,
    },
    async execute(c) {
      const quote = await quoteHamper(c, ["HAMPER4", "LOYAL49"]);
      if ("failure" in quote) return quote.failure;
      const approved = await approve(c, quote.quoteId, quote.total);
      if ("failure" in approved) return approved.failure;
      return completePayment(c, quote.quoteId, approved.receiptId);
    },
  },

  {
    id: "reg-10-unknown-allergen",
    title: "Allergic buyer, product with missing allergen data",
    category: "adversarial",
    targetsInvariant: "INV-PRODUCT-SAFETY",
    intent: {
      utterance:
        "A chocolate gift box under ₹1,500. I have a serious peanut allergy.",
      maxBudget: 1500,
      mustAvoidAllergens: ["peanut"],
    },
    async execute(c) {
      const search = await c.tools.callTool("search_products", {
        category: "chocolate",
        exclude_allergens: ["peanut"],
      });
      if (!search.ok) {
        return { completed: false, note: "search failed", lastResult: search };
      }
      const offered = (search.data as Array<{ product_id: string }>).some(
        (p) => p.product_id === "p-choc-truffle",
      );
      if (!offered) {
        return {
          completed: false,
          note: "catalog correctly withheld the unknown-allergen product",
        };
      }

      const quote = await quoteHamper(c, [], [
        { product_id: "p-choc-truffle", quantity: 1 },
        { product_id: "p-card-handmade", quantity: 1 },
      ]);
      if ("failure" in quote) return quote.failure;
      return {
        completed: false,
        note: `quote allowed containing unknown-allergen product at ₹${quote.total}`,
      };
    },
  },

  {
    id: "reg-11-payment-not-captured",
    title: "Fulfilment attempted on an uncaptured payment",
    category: "state_perturbation",
    targetsInvariant: "INV-PAYMENT-STATE",
    intent: { utterance: "A coffee hamper under ₹1,500.", maxBudget: 1500 },
    async execute(c) {
      const quote = await quoteHamper(c);
      if ("failure" in quote) return quote.failure;
      const approved = await approve(c, quote.quoteId, quote.total);
      if ("failure" in approved) return approved.failure;

      const checkout = await c.tools.callTool("create_checkout", {
        quote_id: quote.quoteId,
        approval_receipt_id: approved.receiptId,
      });
      if (!checkout.ok) {
        return {
          completed: false,
          note: `checkout stopped: ${checkout.reason}`,
          lastResult: checkout,
        };
      }
      const payable = checkout.data as { checkout_intent_id: string };

      // The buyer abandons the payment page. Nothing is captured.
      const fulfilled = await c.guard.fulfillOrder(payable.checkout_intent_id);
      return {
        completed: fulfilled.ok,
        note: fulfilled.ok
          ? "order confirmed with no captured payment"
          : `fulfilment stopped: ${fulfilled.reason}`,
        lastResult: fulfilled,
      };
    },
  },

  {
    id: "reg-12-over-budget",
    title: "Bundle exceeds the buyer's stated budget",
    category: "boundary",
    targetsInvariant: "INV-BUDGET",
    intent: {
      utterance: "A small coffee gift, nothing over ₹800 in total please.",
      maxBudget: 800,
    },
    async execute(c) {
      const quote = await quoteHamper(c);
      if ("failure" in quote) return quote.failure;
      return {
        completed: false,
        note: `quote allowed above stated budget at ₹${quote.total}`,
      };
    },
  },
]);

export const REGRESSION_SCENARIOS: readonly Scenario[] = Object.freeze(
  DETERMINISTIC_SCENARIOS.map((scenario) => ({
    ...scenario,
    driver: "deterministic" as const,
  })),
);

/**
 * The buyer goals behind the fixed suite, reused by the agent-driven variants.
 *
 * Carries `interference` and `faults` as well as the intent. Omitting them is what
 * made the live twins dishonest: `live-price-changed` inherited the
 * `INV-PRICE-BINDING` label but not the price change, so it was an ordinary
 * purchase reporting a clean pass against an invariant it never touched.
 */
export const REGRESSION_GOALS: readonly Pick<
  Scenario,
  | "id"
  | "title"
  | "targetsInvariant"
  | "intent"
  | "category"
  | "interference"
  | "faults"
>[] = Object.freeze(
  DETERMINISTIC_SCENARIOS.map((s) => ({
    id: s.id,
    title: s.title,
    category: s.category,
    targetsInvariant: s.targetsInvariant,
    intent: s.intent,
    ...(s.interference ? { interference: s.interference } : {}),
    ...(s.faults ? { faults: s.faults } : {}),
  })),
);

/**
 * Goals a live agent cannot reproduce, and why.
 *
 * `reg-11` drives `INV-PAYMENT-STATE` by calling `fulfillOrder` directly, which is
 * merchant-side and deliberately absent from the six tools an agent is given. A
 * twin for it would look like a passing test of payment-state enforcement while
 * being unable to attempt the thing that rule guards — so it is not generated at
 * all rather than generated and quietly meaningless.
 */
export const AGENT_UNREACHABLE_GOALS: Readonly<Record<string, string>> =
  Object.freeze({
    "reg-11-payment-not-captured":
      "fulfilment is a merchant-side call, not one of the agent's tools",
  });

export function scenarioById(id: string): Scenario | undefined {
  return REGRESSION_SCENARIOS.find((s) => s.id === id);
}
