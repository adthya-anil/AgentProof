/**
 * Graceful runtime failure (§12).
 *
 * The buyer approves ₹1,399. Before payment, coffee stock is corrected to zero
 * and the hold is broken. AgentProof Guard reloads live inventory at the
 * checkout checkpoint and blocks *before* any payable order is created.
 *
 * Asserted outcomes: zero Razorpay orders, reservation released, and a clear
 * explanation for the buyer.
 */
import { formatMinor, rupees } from "../lib/core/money.js";
import { createEnvironment, createIntent } from "../lib/harness.js";
import { MutationSet } from "../lib/hamperhub/mutations.js";
import { renderChainStatus, renderTrace } from "../lib/report/trace.js";

async function main(): Promise<void> {
  const env = createEnvironment({ mutations: MutationSet.fixed() });
  const { guard, ids, clock, fake } = env;

  const intent = createIntent(ids, clock, {
    runId: "run_blocked",
    utterance: "Send a vegan coffee hamper for my friend's birthday, under ₹1,500.",
    maxBudget: 1500,
    requireVegan: true,
    occasion: "birthday",
    themes: ["coffee"],
  });
  guard.beginIntent(intent);

  console.log("AgentProof — runtime enforcement blocks an unsafe checkout\n");

  const bundle = await guard.callTool("create_bundle", {
    items: [
      { product_id: "p-coffee-arabica", quantity: 1 },
      { product_id: "p-choc-dark-vegan", quantity: 1 },
      { product_id: "p-mug-ceramic", quantity: 1 },
      { product_id: "p-card-handmade", quantity: 1 },
    ],
    promo_codes: ["HAMPERCREDIT"],
  });
  if (!bundle.ok) throw new Error(bundle.reason);

  const quoted = await guard.callTool("create_quote", {
    bundle_id: (bundle.data as { bundle_id: string }).bundle_id,
  });
  if (!quoted.ok) throw new Error(quoted.reason);
  const quote = quoted.data as { quote_id: string; total: number };
  console.log(`Quote ${quote.quote_id} → ₹${quote.total}`);

  const approved = await guard.callTool("approve_quote", {
    quote_id: quote.quote_id,
    approved_amount: quote.total,
    confirmation_text: "Yes, please charge ₹1,399.",
  });
  if (!approved.ok) throw new Error(approved.reason);
  const receiptId = (approved.data as { approval_receipt_id: string })
    .approval_receipt_id;
  console.log(`Buyer approved ₹${quote.total} (receipt ${receiptId})`);

  // --- The world changes between approval and payment. -------------------
  const before = env.state.requireInventory("p-coffee-arabica").available;
  const stockOut = env.state.forceStockOut(
    "p-coffee-arabica",
    "Stock-take correction: shelf count reconciled to zero",
  );
  env.audit.append({
    type: "catalog.state_changed",
    runId: intent.runId,
    intentId: intent.id,
    reason: stockOut.change.reason,
    policyVersion: env.policyVersion,
    output: {
      product_id: "p-coffee-arabica",
      available_before: before,
      available_after: stockOut.change.to,
      inventory_version: stockOut.change.newVersion,
      reservations_broken: stockOut.releasedReservations.length,
    },
  });
  console.log(
    `\n⚠ Inventory changed: p-coffee-arabica ${before} → 0 ` +
      `(${stockOut.releasedReservations.length} reservation(s) broken)\n`,
  );

  // --- Agent proceeds to checkout, unaware. ------------------------------
  clock.advanceMinutes(1);
  const checkout = await guard.callTool("create_checkout", {
    quote_id: quote.quote_id,
    approval_receipt_id: receiptId,
  });

  if (checkout.ok) {
    throw new Error("Checkout succeeded despite a hard stock-out — Guard failed");
  }

  console.log("Audit entry:");
  console.log("  Decision: BLOCKED");
  console.log(`  Reason:\n    ${checkout.reason}`);
  console.log(`  Financial action taken:\n    ${
    checkout.financialActionTaken ? "PAYMENT CREATED" : "None"
  }`);
  console.log(
    "  Required next action:\n    Create a new bundle and request fresh buyer approval.\n",
  );

  console.log("Trace:");
  console.log(renderTrace(env.audit.forIntent(intent.id)));
  console.log(`\n${renderChainStatus(env.audit)}`);

  // --- Verify no money moved. --------------------------------------------
  const orders = fake?.allOrders() ?? [];
  const attempts = env.service.listPaymentAttempts();
  const reservation = env.service.getQuote(quote.quote_id)?.reservationId;
  const reservationStatus = reservation
    ? env.state.getReservation(reservation)?.status
    : "none";

  console.log(`\nProvider orders created: ${orders.length}`);
  console.log(`Payment attempts: ${attempts.length}`);
  console.log(`Reservation status: ${reservationStatus}`);

  if (orders.length !== 0) {
    throw new Error(`Expected 0 provider orders, found ${orders.length}`);
  }
  if (attempts.length !== 0) {
    throw new Error(`Expected 0 payment attempts, found ${attempts.length}`);
  }
  if (checkout.financialActionTaken) {
    throw new Error("Guard reported a financial action on a blocked checkout");
  }

  console.log(
    `\n✓ Checkout blocked before any payment existed. ` +
      `${formatMinor(rupees(quote.total))} was never charged.`,
  );
}

main().catch((error) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
