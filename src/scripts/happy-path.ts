/**
 * The successful buyer-agent journey (§11).
 *
 * Buyer intent: "Create a vegan coffee-themed birthday hamper under ₹1,500."
 *
 * Runs against the *fixed* integration and asserts the exact expected numbers,
 * so this script doubles as an end-to-end regression check rather than a demo
 * that merely prints something plausible.
 */
import { formatMinor, rupees } from "../lib/core/money.js";
import { createEnvironment, createIntent } from "../lib/harness.js";
import { MutationSet } from "../lib/hamperhub/mutations.js";
import { renderChainStatus, renderTrace } from "../lib/report/trace.js";

const EXPECTED_SUBTOTAL = rupees(1446);
const EXPECTED_TOTAL = rupees(1399);

async function main(): Promise<void> {
  const env = createEnvironment({ mutations: MutationSet.fixed() });
  const { guard, ids, clock, fake } = env;

  const intent = createIntent(ids, clock, {
    runId: "run_happy",
    utterance: "Create a vegan coffee-themed birthday hamper under ₹1,500.",
    maxBudget: 1500,
    requireVegan: true,
    occasion: "birthday",
    themes: ["coffee"],
  });
  guard.beginIntent(intent);

  console.log("AgentProof — successful Razorpay-path transaction");
  console.log(`Policy version: ${env.policyVersion}`);
  console.log(`Payment adapter: ${env.payments.name}\n`);

  // 1. Discover vegan products.
  const search = await guard.callTool("search_products", {
    require_vegan: true,
    max_price: 800,
  });
  if (!search.ok) throw new Error(`search failed: ${search.reason}`);
  console.log(
    `search_products → ${(search.data as unknown[]).length} vegan products`,
  );

  // 2. Build the hamper.
  const bundle = await guard.callTool("create_bundle", {
    items: [
      { product_id: "p-coffee-arabica", quantity: 1 },
      { product_id: "p-choc-dark-vegan", quantity: 1 },
      { product_id: "p-mug-ceramic", quantity: 1 },
      { product_id: "p-card-handmade", quantity: 1 },
    ],
    promo_codes: ["HAMPERCREDIT"],
  });
  if (!bundle.ok) throw new Error(`bundle failed: ${bundle.reason}`);
  const bundleId = (bundle.data as { bundle_id: string }).bundle_id;

  // 3. Price it and reserve stock.
  const quoted = await guard.callTool("create_quote", { bundle_id: bundleId });
  if (!quoted.ok) throw new Error(`quote blocked: ${quoted.reason}`);
  const quote = quoted.data as {
    quote_id: string;
    subtotal: number;
    total: number;
  };

  console.log("\nQuote:");
  for (const line of (
    quoted.data as {
      line_items: Array<{ name: string; line_total: number }>;
    }
  ).line_items) {
    console.log(`  ${line.name.padEnd(36)} ₹${line.line_total}`);
  }
  console.log(`  ${"Bundle discount".padEnd(36)} -₹47`);
  console.log(`  ${"-".repeat(44)}`);
  console.log(`  ${"Approved total".padEnd(36)} ₹${quote.total}\n`);

  assertEqual(rupees(quote.subtotal), EXPECTED_SUBTOTAL, "subtotal");
  assertEqual(rupees(quote.total), EXPECTED_TOTAL, "total");

  // 4. Buyer explicitly approves the exact amount.
  const approved = await guard.callTool("approve_quote", {
    quote_id: quote.quote_id,
    approved_amount: quote.total,
    confirmation_text: "Yes, charge me ₹1,399 for this hamper.",
  });
  if (!approved.ok) throw new Error(`approval blocked: ${approved.reason}`);
  const receiptId = (approved.data as { approval_receipt_id: string })
    .approval_receipt_id;

  // 5. Checkout — Guard revalidates everything before any order exists.
  const checkout = await guard.callTool("create_checkout", {
    quote_id: quote.quote_id,
    approval_receipt_id: receiptId,
  });
  if (!checkout.ok) throw new Error(`checkout blocked: ${checkout.reason}`);
  const payable = checkout.data as {
    checkout_intent_id: string;
    payment_attempt_id: string;
    provider_order_id: string;
    amount: number;
  };
  console.log(`Order created: ${payable.provider_order_id} for ₹${payable.amount}`);
  assertEqual(rupees(payable.amount), EXPECTED_TOTAL, "charged amount");

  // 6. Complete the test payment.
  if (!fake) throw new Error("This script expects the offline fake provider");
  await fake.simulatePayment(payable.provider_order_id, "captured");

  const status = await guard.callTool("get_payment_status", {
    payment_attempt_id: payable.payment_attempt_id,
  });
  if (!status.ok) throw new Error(`payment verification failed: ${status.reason}`);
  const verified = status.data as { status: string; verified: boolean };
  console.log(`Payment ${verified.status}, verified=${verified.verified}`);

  // 7. Fulfil — only reachable with a verified captured payment.
  const fulfilled = await guard.fulfillOrder(payable.checkout_intent_id);
  if (!fulfilled.ok) throw new Error(`fulfilment blocked: ${fulfilled.reason}`);

  const coffee = env.state.requireInventory("p-coffee-arabica");
  console.log(
    `Inventory committed: p-coffee-arabica now ${coffee.available} (was 8)\n`,
  );

  console.log("Audit trail:");
  console.log(renderTrace(env.audit.forIntent(intent.id)));
  console.log(`\n${renderChainStatus(env.audit)}`);

  const violations = guard.recordedViolations();
  console.log(`Violations: ${violations.length}`);
  console.log(`Escalations: ${guard.recordedEscalations().length}`);

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`  ✗ [${violation.invariantId}] ${violation.message}`);
    }
    throw new Error("Happy path produced violations; the integration is unsafe");
  }
  if (coffee.available !== 7) {
    throw new Error(`Expected coffee stock 7 after commit, got ${coffee.available}`);
  }

  console.log(
    `\n✓ Happy path complete: ${formatMinor(EXPECTED_TOTAL)} charged, ` +
      `0 violations, audit chain intact.`,
  );
}

function assertEqual(actual: number, expected: number, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label} mismatch: expected ${formatMinor(expected)}, got ${formatMinor(actual)}`,
    );
  }
}

main().catch((error) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
