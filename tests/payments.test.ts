import { afterEach, describe, expect, it } from "vitest";
import { ManualClock } from "../src/lib/core/clock.js";
import { IdFactory } from "../src/lib/core/ids.js";
import { rupees } from "../src/lib/core/money.js";
import { renderCheckoutPage } from "../src/lib/payments/checkoutPage.js";
import {
  describeAdapter,
  selectPaymentAdapter,
} from "../src/lib/payments/factory.js";

function deps() {
  return { ids: new IdFactory("payments-test"), clock: new ManualClock() };
}

describe("selectPaymentAdapter", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("defaults to the offline fake", () => {
    delete process.env.PAYMENT_ADAPTER;
    const selection = selectPaymentAdapter(deps());
    expect(selection.available).toBe(true);
    if (!selection.available) return;
    expect(selection.kind).toBe("fake");
    expect(selection.provider.isReal).toBe(false);
    expect(describeAdapter(selection)).toContain("offline");
  });

  it("reports missing Razorpay credentials without throwing", () => {
    process.env.PAYMENT_ADAPTER = "razorpay";
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;

    const selection = selectPaymentAdapter(deps());
    expect(selection.available).toBe(false);
    if (selection.available) return;
    expect(selection.reason).toMatch(/RAZORPAY_KEY_ID/);
    expect(selection.remediation).toMatch(/rzp_test_/);
  });

  it("refuses live credentials outright", () => {
    process.env.PAYMENT_ADAPTER = "razorpay";
    process.env.RAZORPAY_KEY_ID = "rzp_live_DANGER";
    process.env.RAZORPAY_KEY_SECRET = "secret";

    const selection = selectPaymentAdapter(deps());
    expect(selection.available).toBe(false);
    if (selection.available) return;
    // AgentProof deliberately attempts unsafe transactions; live keys are a
    // hard stop rather than a warning.
    expect(selection.reason).toMatch(/non-test credentials/);
  });

  it("accepts well-formed test credentials", () => {
    process.env.PAYMENT_ADAPTER = "razorpay";
    process.env.RAZORPAY_KEY_ID = "rzp_test_abc123";
    process.env.RAZORPAY_KEY_SECRET = "shhh";

    const selection = selectPaymentAdapter(deps());
    expect(selection.available).toBe(true);
    if (!selection.available) return;
    expect(selection.kind).toBe("razorpay");
    expect(selection.provider.isReal).toBe(true);
    expect(selection.keyId).toBe("rzp_test_abc123");
  });

  it("never exposes the secret in its description", () => {
    process.env.PAYMENT_ADAPTER = "razorpay";
    process.env.RAZORPAY_KEY_ID = "rzp_test_abc123";
    process.env.RAZORPAY_KEY_SECRET = "topsecretvalue";

    const selection = selectPaymentAdapter(deps());
    expect(describeAdapter(selection)).not.toContain("topsecretvalue");
  });

  it("rejects an unknown adapter name", () => {
    process.env.PAYMENT_ADAPTER = "bitcoin";
    const selection = selectPaymentAdapter(deps());
    expect(selection.available).toBe(false);
    if (selection.available) return;
    expect(selection.reason).toMatch(/Unknown PAYMENT_ADAPTER/);
  });
});

describe("renderCheckoutPage", () => {
  const page = () =>
    renderCheckoutPage({
      keyId: "rzp_test_abc123",
      orderId: "order_XYZ",
      amountMinor: rupees(1399),
      currency: "INR",
      quoteId: "quote_1",
      lineItems: [
        { name: "Arabica Coffee", quantity: 1, lineTotalMinor: rupees(599) },
        { name: "Ceramic Mug", quantity: 2, lineTotalMinor: rupees(798) },
      ],
    });

  it("embeds the order id and public key only", () => {
    const html = page();
    expect(html).toContain("order_XYZ");
    expect(html).toContain("rzp_test_abc123");
    expect(html).toContain("checkout.razorpay.com/v1/checkout.js");
  });

  it("renders the amount in rupees with two decimals", () => {
    expect(page()).toContain("₹1399.00");
  });

  it("passes the amount in minor units to Razorpay", () => {
    // Razorpay expects the smallest currency unit; 139900 paise, not 1399.
    expect(page()).toContain("amount: 139900");
  });

  it("lists every line item", () => {
    const html = page();
    expect(html).toContain("Arabica Coffee");
    expect(html).toContain("Ceramic Mug");
  });

  it("escapes HTML in product names", () => {
    const html = renderCheckoutPage({
      keyId: "rzp_test_x",
      orderId: "order_1",
      amountMinor: rupees(100),
      currency: "INR",
      quoteId: "q",
      lineItems: [
        {
          name: '<img src=x onerror="alert(1)">',
          quantity: 1,
          lineTotalMinor: rupees(100),
        },
      ],
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("mentions the test card so a demo needs no external notes", () => {
    expect(page()).toContain("4111 1111 1111 1111");
  });
});
