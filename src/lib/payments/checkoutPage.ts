import { toMajor, type Minor } from "../core/money.js";

export interface CheckoutPageOptions {
  keyId: string;
  orderId: string;
  amountMinor: Minor;
  currency: string;
  quoteId: string;
  lineItems: Array<{ name: string; quantity: number; lineTotalMinor: Minor }>;
}

/**
 * Builds a standalone Razorpay Checkout page for a Guard-authorised order.
 *
 * Capturing a payment cannot be automated from a script: Razorpay requires the
 * buyer to complete Checkout in a browser. So for a live demonstration we emit a
 * self-contained page that opens Checkout for the exact order the Guard already
 * approved. It carries only the public key id and the order id — no secret ever
 * reaches the browser, and the page cannot change the amount, because the amount
 * is fixed server-side on the order.
 */
export function renderCheckoutPage(options: CheckoutPageOptions): string {
  const amountMajor = toMajor(options.amountMinor);
  const rows = options.lineItems
    .map(
      (line) =>
        `<tr><td>${escapeHtml(line.name)}</td><td class="q">${line.quantity}</td>` +
        `<td class="a">₹${toMajor(line.lineTotalMinor).toFixed(2)}</td></tr>`,
    )
    .join("\n        ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AgentProof — complete test payment</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
         max-width: 34rem; margin: 3rem auto; padding: 0 1.25rem; line-height: 1.5; }
  h1 { font-size: 1.25rem; margin-bottom: .25rem; }
  .sub { opacity: .7; font-size: .875rem; margin-bottom: 1.5rem; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: .9rem; }
  td { padding: .4rem 0; border-bottom: 1px solid rgba(128,128,128,.25); }
  .q { text-align: center; width: 3rem; opacity: .7; }
  .a { text-align: right; width: 6rem; font-variant-numeric: tabular-nums; }
  .total { display: flex; justify-content: space-between; font-weight: 600;
           margin: 1rem 0 1.5rem; font-size: 1.05rem; }
  button { font: inherit; font-weight: 600; padding: .7rem 1.25rem; border: 0;
           border-radius: .5rem; background: #3b82f6; color: #fff; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  code { font-size: .8rem; opacity: .75; }
  #result { margin-top: 1.25rem; padding: .85rem 1rem; border-radius: .5rem;
            background: rgba(128,128,128,.12); font-size: .875rem; display: none; }
  .note { margin-top: 2rem; font-size: .8rem; opacity: .65; }
</style>
</head>
<body>
  <h1>HamperHub — Guard-authorised test payment</h1>
  <div class="sub">
    Order <code>${escapeHtml(options.orderId)}</code> ·
    quote <code>${escapeHtml(options.quoteId)}</code>
  </div>

  <table>
    <tbody>
        ${rows}
    </tbody>
  </table>
  <div class="total"><span>Approved total</span>
    <span>₹${amountMajor.toFixed(2)}</span></div>

  <button id="pay">Pay ₹${amountMajor.toFixed(2)} in test mode</button>
  <div id="result"></div>

  <p class="note">
    Razorpay <strong>test mode</strong>. Use card <code>4111 1111 1111 1111</code>,
    any future expiry, any CVV. No real money moves. The amount is fixed on the
    order server-side and cannot be altered from this page.
  </p>

<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>
  var btn = document.getElementById("pay");
  var out = document.getElementById("result");
  function show(html) { out.style.display = "block"; out.innerHTML = html; }

  btn.addEventListener("click", function () {
    var rzp = new Razorpay({
      key: ${JSON.stringify(options.keyId)},
      order_id: ${JSON.stringify(options.orderId)},
      amount: ${options.amountMinor},
      currency: ${JSON.stringify(options.currency)},
      name: "HamperHub",
      description: "AgentProof verified order",
      handler: function (response) {
        btn.disabled = true;
        show(
          "<strong>Payment submitted.</strong><br>payment_id: <code>" +
          response.razorpay_payment_id + "</code><br>" +
          "Return to the AgentProof terminal — it is polling Razorpay and will " +
          "verify this payment before confirming the merchant order."
        );
      },
      modal: {
        ondismiss: function () { show("Checkout dismissed. Nothing was charged."); }
      }
    });
    rzp.open();
  });
</script>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
