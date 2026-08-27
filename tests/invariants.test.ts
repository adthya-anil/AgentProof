import { describe, expect, it } from "vitest";
import { rupees } from "../src/lib/core/money.js";
import { quoteContentHash } from "../src/lib/core/quoteHash.js";
import { PolicyEngine } from "../src/lib/policy/engine.js";
import {
  budgetInvariant,
  confirmationInvariant,
  currencyInvariant,
  discountCapInvariant,
  floorPriceInvariant,
  idempotencyInvariant,
  inventoryInvariant,
  maxAmountInvariant,
  paymentStateInvariant,
  priceBindingInvariant,
  productSafetyInvariant,
  quoteExpiryInvariant,
} from "../src/lib/policy/invariants/index.js";
import {
  buildApproval,
  buildCheckout,
  buildPayment,
  buildQuote,
  ctx,
  fixture,
  pct,
} from "./helpers.js";

const HAMPER = [
  { productId: "p-coffee-arabica", quantity: 1 },
  { productId: "p-choc-dark-vegan", quantity: 1 },
  { productId: "p-mug-ceramic", quantity: 1 },
  { productId: "p-card-handmade", quantity: 1 },
];

describe("INV-DISCOUNT-CAP", () => {
  it("passes a single discount within the cap", () => {
    const f = fixture();
    const quote = buildQuote(f, HAMPER, {
      discounts: [
        {
          code: "HAMPERCREDIT",
          label: "credit",
          kind: "bundle",
          percent: 0,
          amountMinor: rupees(47),
          appliedToMinor: rupees(1446),
        },
      ],
    });
    expect(quote.totalMinor).toBe(rupees(1399));
    const result = discountCapInvariant.evaluate(
      ctx(f, { checkpoint: "quote.created", quote }),
    );
    expect(result.status).toBe("pass");
  });

  it("catches two sub-cap discounts that stack to 8.7%", () => {
    const f = fixture();
    const subtotal = rupees(1446);
    const first = pct("HAMPER4", 4, subtotal);
    const second = pct("LOYAL49", 4.9, subtotal - first.amountMinor);
    const quote = buildQuote(f, HAMPER, { discounts: [first, second] });

    const result = discountCapInvariant.evaluate(
      ctx(f, { checkpoint: "quote.created", quote }),
    );

    expect(result.status).toBe("violation");
    if (result.status !== "violation") return;
    // Each component is under 5%; the effective rate is not.
    expect(first.percent).toBeLessThan(5);
    expect(second.percent).toBeLessThan(5);
    expect(result.observed?.effectiveDiscountPercent).toBe(8.7);
    expect(result.message).toContain("8.7%");
    expect(result.moneyAtRiskMinor).toBeGreaterThan(0);
  });

  it("flags stacking even when the effective rate is within the cap", () => {
    const f = fixture();
    const subtotal = rupees(1446);
    const a = pct("HAMPER4", 2, subtotal);
    const b = pct("LOYAL49", 2, subtotal - a.amountMinor);
    const quote = buildQuote(f, HAMPER, { discounts: [a, b] });

    const result = discountCapInvariant.evaluate(
      ctx(f, { checkpoint: "quote.created", quote }),
    );
    expect(result.status).toBe("violation");
    if (result.status !== "violation") return;
    expect(result.message).toContain("forbids stacking");
  });
});

describe("INV-FLOOR-PRICE", () => {
  it("passes a modest discount", () => {
    const f = fixture();
    const quote = buildQuote(f, HAMPER, {
      discounts: [
        {
          code: "HAMPERCREDIT",
          label: "credit",
          kind: "bundle",
          percent: 0,
          amountMinor: rupees(47),
          appliedToMinor: rupees(1446),
        },
      ],
    });
    expect(
      floorPriceInvariant.evaluate(ctx(f, { checkpoint: "quote.created", quote }))
        .status,
    ).toBe("pass");
  });

  it("catches a line pushed below its minimum permitted price", () => {
    const f = fixture();
    const quote = buildQuote(f, HAMPER, {
      discounts: [pct("HAMPER4", 30, rupees(1446))],
    });
    const result = floorPriceInvariant.evaluate(
      ctx(f, { checkpoint: "quote.created", quote }),
    );
    expect(result.status).toBe("violation");
    if (result.status !== "violation") return;
    expect(result.message).toContain("below the merchant's minimum");
  });
});

describe("INV-QUOTE-EXPIRY", () => {
  it("passes inside the window", () => {
    const f = fixture();
    const quote = buildQuote(f, HAMPER);
    f.clock.advanceMinutes(5);
    expect(
      quoteExpiryInvariant.evaluate(
        ctx(f, { checkpoint: "checkout.requested", quote }),
      ).status,
    ).toBe("pass");
  });

  it("blocks an expired quote", () => {
    const f = fixture();
    const quote = buildQuote(f, HAMPER);
    f.clock.advanceMinutes(11);
    const result = quoteExpiryInvariant.evaluate(
      ctx(f, { checkpoint: "checkout.requested", quote }),
    );
    expect(result.status).toBe("violation");
    if (result.status !== "violation") return;
    expect(result.message).toContain("expired");
  });

  it("rejects a validity window longer than policy allows", () => {
    const f = fixture();
    const quote = buildQuote(f, HAMPER, { expiryMinutes: 24 * 60 });
    const result = quoteExpiryInvariant.evaluate(
      ctx(f, { checkpoint: "checkout.requested", quote }),
    );
    expect(result.status).toBe("violation");
    if (result.status !== "violation") return;
    expect(result.message).toContain("policy limit");
  });
});

describe("INV-PRICE-BINDING", () => {
  it("passes when nothing moved", () => {
    const f = fixture();
    const quote = buildQuote(f, HAMPER);
    const approval = buildApproval(f, quote);
    expect(
      priceBindingInvariant.evaluate(
        ctx(f, { checkpoint: "checkout.requested", quote, approval }),
      ).status,
    ).toBe("pass");
  });

  it("catches a price change after the quote was priced", () => {
    const f = fixture();
    const quote = buildQuote(f, HAMPER);
    const approval = buildApproval(f, quote);
    f.state.setPrice("p-coffee-arabica", rupees(649), "supplier increase");

    const result = priceBindingInvariant.evaluate(
      ctx(f, { checkpoint: "checkout.requested", quote, approval }),
    );
    expect(result.status).toBe("violation");
    if (result.status !== "violation") return;
    expect(result.message).toContain("v1");
    expect(result.moneyAtRiskMinor).toBe(rupees(50));
  });

  it("catches an approval bound to an older quote version", () => {
    const f = fixture();
    const quote = buildQuote(f, HAMPER, { version: 2 });
    const approval = buildApproval(f, quote, { quoteVersion: 1 });
    const result = priceBindingInvariant.evaluate(
      ctx(f, { checkpoint: "checkout.requested", quote, approval }),
    );
    expect(result.status).toBe("violation");
    if (result.status !== "violation") return;
    expect(result.message).toContain("bound to quote");
  });

  it("catches a same-total substitution after approval", () => {
    const f = fixture();
    const quote = buildQuote(f, HAMPER);
    // Approve the real basket, then swap an item for one of identical price.
    const approval = buildApproval(f, quote);
    const swapped = {
      ...quote,
      lineItems: quote.lineItems.map((line) =>
        line.productId === "p-choc-dark-vegan"
          ? { ...line, productId: "p-choc-truffle", name: "Truffle" }
          : line,
      ),
    };
    expect(quoteContentHash(swapped)).not.toBe(approval.approvedContentHash);

    const result = priceBindingInvariant.evaluate(
      ctx(f, { checkpoint: "checkout.requested", quote: swapped, approval }),
    );
    expect(result.status).toBe("violation");
  });
});

describe("INV-INVENTORY", () => {
  it("passes while stock is held", () => {
    const f = fixture();
    const quote = buildQuote(f, HAMPER);
    expect(
      inventoryInvariant.evaluate(
        ctx(f, { checkpoint: "checkout.requested", quote }),
      ).status,
    ).toBe("pass");
  });

  it("tolerates lower availability that the reservation still covers", () => {
    const f = fixture();
    const quote = buildQuote(f, HAMPER);
    // One unit left, and it is the one we hold.
    f.state.setStock("p-coffee-arabica", 1, "sales elsewhere");
    expect(
      inventoryInvariant.evaluate(
        ctx(f, { checkpoint: "checkout.requested", quote }),
      ).status,
    ).toBe("pass");
  });

  it("blocks a hard stock-out that breaks the hold", () => {
    const f = fixture();
    const quote = buildQuote(f, HAMPER);
    f.state.forceStockOut("p-coffee-arabica", "stock-take correction");

    const result = inventoryInvariant.evaluate(
      ctx(f, { checkpoint: "checkout.requested", quote }),
    );
    expect(result.status).toBe("violation");
    if (result.status !== "violation") return;
    expect(result.message).toContain("Inventory changed after quote approval");
  });

  it("blocks checkout with no reservation at all", () => {
    const f = fixture();
    const quote = buildQuote(f, HAMPER, { reserve: false });
    const result = inventoryInvariant.evaluate(
      ctx(f, { checkpoint: "checkout.requested", quote }),
    );
    expect(result.status).toBe("violation");
    if (result.status !== "violation") return;
    expect(result.message).toContain("without an inventory reservation");
  });
});

describe("INV-CONFIRMATION", () => {
  it("passes with a matching approval", () => {
    const f = fixture();
    const quote = buildQuote(f, HAMPER);
    const approval = buildApproval(f, quote);
    const checkoutIntent = buildCheckout(f, quote);
    expect(
      confirmationInvariant.evaluate(
        ctx(f, {
          checkpoint: "checkout.requested",
          quote,
          approval,
          checkoutIntent,
        }),
      ).status,
    ).toBe("pass");
  });

  it("blocks checkout with no approval receipt", () => {
    const f = fixture();
    const quote = buildQuote(f, HAMPER);
    const checkoutIntent = buildCheckout(f, quote, { approvalReceiptId: null });
    const result = confirmationInvariant.evaluate(
      ctx(f, { checkpoint: "checkout.requested", quote, checkoutIntent }),
    );
    expect(result.status).toBe("violation");
    if (result.status !== "violation") return;
    expect(result.message).toContain("no approval receipt");
  });

  it("blocks an amount that differs from what was approved", () => {
    const f = fixture();
    const quote = buildQuote(f, HAMPER);
    const approval = buildApproval(f, quote, {
      approvedAmountMinor: rupees(1200),
    });
    const checkoutIntent = buildCheckout(f, quote);
    const result = confirmationInvariant.evaluate(
      ctx(f, {
        checkpoint: "checkout.requested",
        quote,
        approval,
        checkoutIntent,
      }),
    );
    expect(result.status).toBe("violation");
  });

  it("blocks an approval reused from another buyer intent", () => {
    const f = fixture();
    const quote = buildQuote(f, HAMPER);
    const approval = buildApproval(f, quote, { intentId: "intent_someone_else" });
    const checkoutIntent = buildCheckout(f, quote);
    const result = confirmationInvariant.evaluate(
      ctx(f, {
        checkpoint: "checkout.requested",
        quote,
        approval,
        checkoutIntent,
      }),
    );
    expect(result.status).toBe("violation");
    if (result.status !== "violation") return;
    expect(result.message).toContain("reused across conversations");
  });

  it("blocks an empty confirmation string", () => {
    const f = fixture();
    const quote = buildQuote(f, HAMPER);
    const approval = buildApproval(f, quote, { confirmationText: "   " });
    const checkoutIntent = buildCheckout(f, quote);
    expect(
      confirmationInvariant.evaluate(
        ctx(f, {
          checkpoint: "checkout.requested",
          quote,
          approval,
          checkoutIntent,
        }),
      ).status,
    ).toBe("violation");
  });
});

describe("INV-IDEMPOTENCY", () => {
  it("passes for a first checkout", () => {
    const f = fixture();
    const quote = buildQuote(f, HAMPER);
    const checkoutIntent = buildCheckout(f, quote);
    expect(
      idempotencyInvariant.evaluate(
        ctx(f, { checkpoint: "checkout.requested", quote, checkoutIntent }),
      ).status,
    ).toBe("pass");
  });

  it("blocks a repeated idempotency key", () => {
    const f = fixture();
    const quote = buildQuote(f, HAMPER);
    const first = buildCheckout(f, quote, { id: "chk_first", status: "authorized" });
    const retry = buildCheckout(f, quote, { id: "chk_second" });
    const result = idempotencyInvariant.evaluate(
      ctx(f, {
        checkpoint: "checkout.requested",
        quote,
        checkoutIntent: retry,
        priorCheckoutIntents: [first],
      }),
    );
    expect(result.status).toBe("violation");
    if (result.status !== "violation") return;
    expect(result.message).toContain("Duplicate checkout");
  });

  it("blocks a second payable order under a fresh key", () => {
    const f = fixture();
    const quote = buildQuote(f, HAMPER);
    const first = buildCheckout(f, quote, {
      id: "chk_first",
      idempotencyKey: "idem_random_1",
      status: "requested",
    });
    const retry = buildCheckout(f, quote, {
      id: "chk_second",
      idempotencyKey: "idem_random_2",
    });
    const result = idempotencyInvariant.evaluate(
      ctx(f, {
        checkpoint: "checkout.requested",
        quote,
        checkoutIntent: retry,
        priorCheckoutIntents: [first],
      }),
    );
    expect(result.status).toBe("violation");
    if (result.status !== "violation") return;
    expect(result.message).toContain("one payment per intent");
  });

  it("ignores a previously blocked attempt", () => {
    const f = fixture();
    const quote = buildQuote(f, HAMPER);
    const blocked = buildCheckout(f, quote, {
      id: "chk_blocked",
      status: "blocked",
    });
    const retry = buildCheckout(f, quote, { id: "chk_second" });
    expect(
      idempotencyInvariant.evaluate(
        ctx(f, {
          checkpoint: "checkout.requested",
          quote,
          checkoutIntent: retry,
          priorCheckoutIntents: [blocked],
        }),
      ).status,
    ).toBe("pass");
  });
});

describe("INV-PRODUCT-SAFETY", () => {
  it("skips when the buyer stated no constraints", () => {
    const f = fixture();
    const quote = buildQuote(f, HAMPER);
    expect(
      productSafetyInvariant.evaluate(ctx(f, { checkpoint: "quote.created", quote }))
        .status,
    ).toBe("skipped");
  });

  it("blocks a known allergen conflict", () => {
    const f = fixture();
    f.intent.constraints.mustAvoidAllergens = ["peanut"];
    const quote = buildQuote(f, [{ productId: "p-snack-trailmix", quantity: 1 }]);
    const result = productSafetyInvariant.evaluate(
      ctx(f, { checkpoint: "quote.created", quote }),
    );
    expect(result.status).toBe("violation");
    if (result.status !== "violation") return;
    expect(result.message).toContain("peanut");
  });

  it("escalates unknown allergen data rather than allowing it", () => {
    const f = fixture();
    f.intent.constraints.mustAvoidAllergens = ["peanut"];
    const quote = buildQuote(f, [{ productId: "p-choc-truffle", quantity: 1 }]);
    const result = productSafetyInvariant.evaluate(
      ctx(f, { checkpoint: "quote.created", quote }),
    );
    // Unknown is never 'pass'. Under `escalate` policy it must escalate.
    expect(result.status).toBe("escalation");
    if (result.status !== "escalation") return;
    expect(result.message).toContain("cannot be interpreted as safe");
  });

  it("treats unknown data as a violation under block policy", () => {
    const f = fixture();
    f.policy = {
      ...f.policy,
      products: { ...f.policy.products, unknownAllergenStatus: "block" },
    };
    f.intent.constraints.mustAvoidAllergens = ["peanut"];
    const quote = buildQuote(f, [{ productId: "p-choc-truffle", quantity: 1 }]);
    expect(
      productSafetyInvariant.evaluate(ctx(f, { checkpoint: "quote.created", quote }))
        .status,
    ).toBe("violation");
  });

  it("blocks a non-vegan item for a vegan buyer", () => {
    const f = fixture();
    f.intent.constraints.requireVegan = true;
    const quote = buildQuote(f, [{ productId: "p-choc-milk", quantity: 1 }]);
    expect(
      productSafetyInvariant.evaluate(ctx(f, { checkpoint: "quote.created", quote }))
        .status,
    ).toBe("violation");
  });
});

describe("INV-BUDGET and INV-MAX-AMOUNT", () => {
  it("flags a quote above the buyer's stated budget", () => {
    const f = fixture();
    f.intent.constraints.maxBudgetMinor = rupees(1000);
    const quote = buildQuote(f, HAMPER);
    const result = budgetInvariant.evaluate(
      ctx(f, { checkpoint: "quote.created", quote }),
    );
    expect(result.status).toBe("violation");
  });

  it("blocks charging more than was approved", () => {
    const f = fixture();
    const quote = buildQuote(f, HAMPER);
    const approval = buildApproval(f, quote, {
      approvedAmountMinor: rupees(1000),
    });
    const checkoutIntent = buildCheckout(f, quote);
    const result = budgetInvariant.evaluate(
      ctx(f, {
        checkpoint: "checkout.requested",
        quote,
        approval,
        checkoutIntent,
      }),
    );
    expect(result.status).toBe("violation");
    if (result.status !== "violation") return;
    expect(result.moneyAtRiskMinor).toBe(quote.totalMinor - rupees(1000));
  });

  it("blocks a transaction above the merchant ceiling", () => {
    const f = fixture();
    const quote = buildQuote(f, [{ productId: "p-coffee-beans-dark", quantity: 8 }]);
    expect(quote.totalMinor).toBeGreaterThan(f.policy.transaction.maximumAmountMinor);
    expect(
      maxAmountInvariant.evaluate(ctx(f, { checkpoint: "quote.created", quote }))
        .status,
    ).toBe("violation");
  });
});

describe("INV-PAYMENT-STATE", () => {
  it("blocks fulfilment on an uncaptured payment", () => {
    const f = fixture();
    const quote = buildQuote(f, HAMPER);
    const checkoutIntent = buildCheckout(f, quote);
    const paymentAttempt = buildPayment(f, quote.totalMinor, {
      status: "created",
      verified: false,
    });
    const result = paymentStateInvariant.evaluate(
      ctx(f, { checkpoint: "order.fulfilled", quote, checkoutIntent, paymentAttempt }),
    );
    expect(result.status).toBe("violation");
    if (result.status !== "violation") return;
    expect(result.message).toContain("never captured");
  });

  it("blocks fulfilment on an unverified capture", () => {
    const f = fixture();
    const quote = buildQuote(f, HAMPER);
    const checkoutIntent = buildCheckout(f, quote);
    const paymentAttempt = buildPayment(f, quote.totalMinor, { verified: false });
    expect(
      paymentStateInvariant.evaluate(
        ctx(f, {
          checkpoint: "order.fulfilled",
          quote,
          checkoutIntent,
          paymentAttempt,
        }),
      ).status,
    ).toBe("violation");
  });

  it("blocks a captured amount that differs from the authorisation", () => {
    const f = fixture();
    const quote = buildQuote(f, HAMPER);
    const checkoutIntent = buildCheckout(f, quote);
    const paymentAttempt = buildPayment(f, rupees(2000));
    expect(
      paymentStateInvariant.evaluate(
        ctx(f, {
          checkpoint: "payment.verified",
          quote,
          checkoutIntent,
          paymentAttempt,
        }),
      ).status,
    ).toBe("violation");
  });

  it("passes a verified capture for the right amount", () => {
    const f = fixture();
    const quote = buildQuote(f, HAMPER);
    const checkoutIntent = buildCheckout(f, quote);
    const paymentAttempt = buildPayment(f, quote.totalMinor);
    expect(
      paymentStateInvariant.evaluate(
        ctx(f, {
          checkpoint: "order.fulfilled",
          quote,
          checkoutIntent,
          paymentAttempt,
        }),
      ).status,
    ).toBe("pass");
  });
});

describe("INV-CURRENCY", () => {
  it("blocks a mismatched payment currency", () => {
    const f = fixture();
    const quote = buildQuote(f, HAMPER);
    const paymentAttempt = buildPayment(f, quote.totalMinor, {
      currency: "USD" as "INR",
    });
    const result = currencyInvariant.evaluate(
      ctx(f, { checkpoint: "payment.verified", quote, paymentAttempt }),
    );
    expect(result.status).toBe("violation");
    if (result.status !== "violation") return;
    expect(result.message).toContain("USD");
  });
});

describe("PolicyEngine", () => {
  it("evaluates every applicable invariant rather than stopping at the first", () => {
    const f = fixture();
    f.intent.constraints.mustAvoidAllergens = ["peanut"];
    // A quote that is simultaneously over-discounted and unsafe.
    const quote = buildQuote(f, [{ productId: "p-snack-trailmix", quantity: 1 }], {
      discounts: [pct("FESTIVE10", 20, rupees(279))],
    });

    const evaluation = new PolicyEngine().evaluate(
      ctx(f, { checkpoint: "quote.created", quote }),
    );

    const fired = evaluation.violations.map((v) => v.invariantId);
    expect(fired).toContain("INV-DISCOUNT-CAP");
    expect(fired).toContain("INV-PRODUCT-SAFETY");
    expect(evaluation.decision).toBe("block");
    expect(evaluation.moneyAtRiskMinor).toBeGreaterThan(0);
  });

  it("escalates when nothing is violated but a decision needs a human", () => {
    const f = fixture();
    f.intent.constraints.mustAvoidAllergens = ["peanut"];
    const quote = buildQuote(f, [{ productId: "p-choc-truffle", quantity: 1 }]);

    const evaluation = new PolicyEngine().evaluate(
      ctx(f, { checkpoint: "quote.created", quote }),
    );
    expect(evaluation.violations).toHaveLength(0);
    expect(evaluation.escalations).toHaveLength(1);
    expect(evaluation.decision).toBe("escalate");
  });

  it("allows a clean quote", () => {
    const f = fixture();
    const quote = buildQuote(f, HAMPER, {
      discounts: [
        {
          code: "HAMPERCREDIT",
          label: "credit",
          kind: "bundle",
          percent: 0,
          amountMinor: rupees(47),
          appliedToMinor: rupees(1446),
        },
      ],
    });
    const evaluation = new PolicyEngine().evaluate(
      ctx(f, { checkpoint: "quote.created", quote }),
    );
    expect(evaluation.decision).toBe("allow");
    expect(evaluation.violations).toHaveLength(0);
  });

  it("reports a throwing invariant as a finding instead of passing", () => {
    const f = fixture();
    const engine = new PolicyEngine([
      {
        id: "INV-EXPLODE",
        title: "explodes",
        severity: "high",
        policyRefs: [],
        attribution: "integration",
        appliesAt: ["quote.created"],
        evaluate() {
          throw new Error("boom");
        },
      },
    ]);
    const evaluation = engine.evaluate(ctx(f, { checkpoint: "quote.created" }));
    expect(evaluation.decision).toBe("block");
    expect(evaluation.violations[0]?.message).toContain("boom");
  });
});
