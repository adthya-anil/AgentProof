/**
 * A real Razorpay test-mode transaction, driven by the buyer agent (§11).
 *
 * This is the one script that talks to Razorpay's actual API. It runs the agent
 * through the Guard, and when every invariant passes the Guard creates a genuine
 * test-mode order. It then demonstrates the payment-state invariant: the merchant
 * order cannot be fulfilled until a captured payment has been re-read from
 * Razorpay and matched.
 *
 * Capture itself needs a browser — Razorpay Checkout cannot be completed from a
 * script — so the script writes a self-contained checkout page and can poll until
 * the payment lands.
 *
 *   npm run demo:razorpay              create the order, show how to pay
 *   npm run demo:razorpay -- --wait=180   ...then poll for up to 180s
 *
 * Requires PAYMENT_ADAPTER=razorpay and rzp_test_ credentials. Without them it
 * explains what to configure and exits successfully, so it is safe to run in CI.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { loadDotEnv } from "../lib/core/env.js";
import { resolve } from "node:path";
import { BuyerAgent } from "../lib/agent/buyer.js";
import { ScriptedLLM, encodeStrategy } from "../lib/agent/scripted.js";
import { IdFactory } from "../lib/core/ids.js";
import { ManualClock } from "../lib/core/clock.js";
import { formatMinor } from "../lib/core/money.js";
import { createEnvironment, createIntent } from "../lib/harness.js";
import { MutationSet } from "../lib/hamperhub/mutations.js";
import { renderCheckoutPage } from "../lib/payments/checkoutPage.js";
import { describeAdapter, selectPaymentAdapter } from "../lib/payments/factory.js";
import { renderChainStatus, renderTrace } from "../lib/report/trace.js";

const HAMPER = [
  { product_id: "p-coffee-arabica", quantity: 1 },
  { product_id: "p-choc-dark-vegan", quantity: 1 },
  { product_id: "p-mug-ceramic", quantity: 1 },
  { product_id: "p-card-handmade", quantity: 1 },
];

function useHostedLink(): boolean {
  return process.argv.includes("--link");
}

function parseWaitSeconds(): number {
  const arg = process.argv.find((a) => a.startsWith("--wait"));
  if (!arg) return 0;
  const value = arg.includes("=") ? arg.split("=")[1] : "120";
  const parsed = Number.parseInt(value ?? "120", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120;
}

async function main(): Promise<void> {
  // Must happen before any adapter reads process.env.
  loadDotEnv();
  const waitSeconds = parseWaitSeconds();

  // The real adapter needs real time, not the deterministic ManualClock, because
  // quote expiry is compared against wall-clock while we wait for a human to pay.
  const clock = new ManualClock(new Date());
  const ids = new IdFactory(`live-${Date.now()}`);
  const hosted = useHostedLink();
  const selection = selectPaymentAdapter({
    ids,
    clock,
    collectionMode: hosted ? "payment_link" : "order",
  });

  console.log("AgentProof — real Razorpay test-mode transaction");
  console.log(
    `Payment adapter: ${describeAdapter(selection)}` +
      `${hosted ? " · hosted payment link" : ""}\n`,
  );

  if (!selection.available) {
    console.log("This script needs Razorpay test credentials.\n");
    console.log(`  Reason: ${selection.reason}`);
    console.log(`  Fix:    ${selection.remediation}\n`);
    console.log("Then run:");
    console.log("  PAYMENT_ADAPTER=razorpay npm run demo:razorpay -- --wait=180\n");
    console.log(
      "Everything else in AgentProof runs offline: `npm run demo:preflight`\n" +
        "exercises the identical Guard and invariants against a deterministic\n" +
        "in-process provider.",
    );
    return;
  }

  if (selection.kind !== "razorpay") {
    console.log(
      "PAYMENT_ADAPTER is 'fake'. Set PAYMENT_ADAPTER=razorpay to create a real\n" +
        "test-mode order.",
    );
    return;
  }

  const env = createEnvironment({
    mutations: MutationSet.fixed(),
    paymentProvider: selection.provider,
    clock,
    mode: "runtime",
  });

  const intent = createIntent(env.ids, env.clock, {
    runId: `run_live_${Date.now()}`,
    utterance: "Create a vegan coffee-themed birthday hamper under ₹1,500.",
    maxBudget: 1500,
    requireVegan: true,
    occasion: "birthday",
    themes: ["coffee"],
  });
  env.guard.beginIntent(intent);

  // The agent drives the journey up to checkout. It never sees a credential.
  const agent = new BuyerAgent({
    llm: new ScriptedLLM(),
    guard: env.guard,
    systemSuffix: encodeStrategy({
      label: "live razorpay hamper",
      steps: [
        { tool: "search_products", args: { require_vegan: true, max_price: 800 } },
        {
          tool: "create_bundle",
          args: { items: HAMPER, promo_codes: ["HAMPERCREDIT"] },
        },
        { tool: "create_quote", args: { bundle_id: "$ref:bundle_id" } },
        {
          tool: "approve_quote",
          args: {
            quote_id: "$ref:quote_id",
            approved_amount: "$ref:total",
            confirmation_text: "Yes, charge me ₹1,399 for this hamper.",
          },
        },
        {
          tool: "create_checkout",
          args: {
            quote_id: "$ref:quote_id",
            approval_receipt_id: "$ref:approval_receipt_id",
          },
        },
      ],
    }),
  });

  const run = await agent.run(intent);
  console.log("Buyer agent journey:");
  for (const entry of run.transcript) {
    console.log(`  ${entry.ok ? "✓" : "✗"} ${entry.tool.padEnd(20)} ${entry.summary}`);
  }
  console.log();

  const violations = env.guard.recordedViolations();
  if (violations.length > 0) {
    console.error("Guard blocked the journey; no order was created:");
    for (const v of violations) {
      console.error(`  ✗ [${v.invariantId}] ${v.message}`);
    }
    process.exit(1);
  }

  const checkout = env.service
    .listCheckoutIntents(intent.id)
    .find((c) => c.status === "authorized");
  if (!checkout) {
    // The Guard passed every invariant, so a failure here came from Razorpay
    // itself. Surface its actual message rather than a generic complaint.
    const failed = run.transcript.filter((t) => !t.ok).pop();
    console.error("No payable order was created.");
    if (failed) {
      console.error(`  ${failed.tool} failed: ${failed.summary}`);
    }
    if (failed?.summary.includes("Authentication failed")) {
      console.error(
        "\n  Razorpay rejected the credentials. Check RAZORPAY_KEY_ID and\n" +
          "  RAZORPAY_KEY_SECRET are a matching test-mode pair from\n" +
          "  Settings → API Keys in the Razorpay dashboard.",
      );
    }
    process.exit(1);
  }

  const attempt = env.service.findPaymentAttemptForCheckout(checkout.id);
  if (!attempt) {
    console.error("No payment attempt was recorded.");
    process.exit(1);
  }

  const quote = env.service.getQuote(checkout.quoteId)!;
  console.log(
    `Guard authorised the checkout. Razorpay test ` +
      `${hosted ? "payment link" : "order"} created:`,
  );
  console.log(`  ${hosted ? "link id:  " : "order id: "} ${attempt.providerOrderId}`);
  console.log(`  amount:    ${formatMinor(attempt.amountMinor)} ${attempt.currency}`);
  console.log(`  receipt:   ${checkout.idempotencyKey}`);
  console.log(`  quote:     ${quote.id} v${quote.version}\n`);

  // Before capture, fulfilment must be impossible. Prove it.
  //
  // This probe deliberately trips INV-PAYMENT-STATE, so its finding is an
  // expected assertion rather than a defect. Count what came before it so the
  // closing summary can separate the two instead of reporting a scary
  // "1 violation" on a successful run.
  const violationsBeforeProbe = env.guard.recordedViolations().length;
  const premature = await env.guard.fulfillOrder(checkout.id);
  if (premature.ok) {
    console.error(
      "✗ Order was fulfilled before payment capture — INV-PAYMENT-STATE failed.",
    );
    process.exit(1);
  }
  const probeVerdicts =
    env.guard.recordedViolations().length - violationsBeforeProbe;
  console.log("Fulfilment attempted before capture (deliberate probe):");
  console.log(`  BLOCKED — ${premature.reason}`);
  console.log(
    `  INV-PAYMENT-STATE fired as expected (${probeVerdicts} verdict).\n`,
  );

  const hostedUrl = attempt.hostedUrl;

  // Give the operator a way to actually complete the payment. A hosted link is
  // a URL anyone can open; the order flow needs a local page running Razorpay's
  // browser SDK, which only helps if you can reach the filesystem.
  if (hostedUrl) {
    console.log("Open this URL in any browser to complete the test payment:");
    console.log(`\n  ${hostedUrl}\n`);
    console.log("  Test card 4111 1111 1111 1111, any future expiry, any CVV.");
    console.log("  No real money moves in test mode.\n");
  } else {
    const dir = resolve(process.cwd(), "runs");
    mkdirSync(dir, { recursive: true });
    const pagePath = resolve(dir, `checkout-${attempt.providerOrderId}.html`);
    writeFileSync(
      pagePath,
      renderCheckoutPage({
        keyId: selection.keyId!,
        orderId: attempt.providerOrderId,
        amountMinor: attempt.amountMinor,
        currency: attempt.currency,
        quoteId: quote.id,
        lineItems: quote.lineItems.map((l) => ({
          name: l.name,
          quantity: l.quantity,
          lineTotalMinor: l.lineTotalMinor,
        })),
      }),
      "utf8",
    );
    console.log("To complete the test payment, open this page in a browser:");
    console.log(`  ${pagePath}`);
    console.log("  Test card 4111 1111 1111 1111, any future expiry, any CVV.");
    console.log(
      "  If you cannot reach that file, re-run with --link for a hosted URL.\n",
    );
  }

  if (waitSeconds === 0) {
    console.log(
      "Re-run with --wait=180 to poll Razorpay and finish the flow " +
        "(verify → fulfil).",
    );
    console.log(`\n${renderChainStatus(env.audit)}`);
    return;
  }

  // Poll Razorpay for the payment, then verify and fulfil.
  console.log(`Polling Razorpay for up to ${waitSeconds}s...`);
  const deadline = Date.now() + waitSeconds * 1000;
  let captured = false;
  let lastStatus = attempt.status;

  while (Date.now() < deadline) {
    // Keep the injected clock aligned with real time so quote expiry is honest.
    clock.set(new Date());

    const status = await env.guard.callTool("get_payment_status", {
      payment_attempt_id: attempt.id,
    });
    if (status.ok) {
      const data = status.data as { status: string; verified: boolean };
      if (data.status !== lastStatus) {
        console.log(`  status: ${data.status} (verified=${data.verified})`);
        lastStatus = data.status as typeof lastStatus;
      }
      if (data.status === "captured" && data.verified) {
        captured = true;
        break;
      }
      if (data.status === "authorized") {
        console.log(
          "  payment is authorized but not captured — INV-PAYMENT-STATE will " +
            "keep blocking fulfilment until capture, which is correct.",
        );
      }
      if (data.status === "failed") {
        console.log("  payment failed; the merchant order stays unfulfilled.");
        break;
      }
    } else {
      console.log(`  verification blocked: ${status.reason}`);
    }
    await sleep(5000);
  }

  console.log();
  if (!captured) {
    console.log(
      "No captured payment observed within the window. The order remains " +
        "unfulfilled, which is the correct outcome.",
    );
    console.log(`\nAudit trail:\n${renderTrace(env.audit.forIntent(intent.id))}`);
    console.log(`\n${renderChainStatus(env.audit)}`);
    return;
  }

  const fulfilled = await env.guard.fulfillOrder(checkout.id);
  if (!fulfilled.ok) {
    console.error(`✗ Fulfilment blocked after capture: ${fulfilled.reason}`);
    process.exit(1);
  }

  const coffee = env.state.requireInventory("p-coffee-arabica");
  console.log("Payment captured and verified against Razorpay.");
  console.log(`Merchant order confirmed. Inventory committed: coffee ${coffee.available}.\n`);
  console.log(`Audit trail:\n${renderTrace(env.audit.forIntent(intent.id))}`);
  console.log(`\n${renderChainStatus(env.audit)}`);
  const totalVerdicts = env.guard.recordedViolations().length;
  const unexpected = totalVerdicts - probeVerdicts;
  console.log(
    `\n✓ Real Razorpay test transaction complete: ` +
      `${formatMinor(attempt.amountMinor)} captured and verified, ` +
      `${hosted ? "link" : "order"} ${attempt.providerOrderId}.`,
  );
  console.log(
    `  Guard verdicts: ${probeVerdicts} expected ` +
      `(the pre-capture probe), ${unexpected} unexpected.`,
  );
  if (unexpected !== 0) {
    console.error("  ✗ An unexpected violation occurred on a successful run.");
    process.exit(1);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((error) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
