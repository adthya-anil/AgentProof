import { BuyerAgent } from "../agent/buyer.js";
import { ScriptedLLM, encodeStrategy } from "../agent/scripted.js";
import type { Minor } from "../core/money.js";
import { createIntent } from "../harness.js";
import type { Environment } from "../harness.js";
import { createEnvironment } from "../harness.js";
import { MutationSet } from "../hamperhub/mutations.js";
import type { Violation } from "../policy/violations.js";
import { integrationDefects } from "../policy/violations.js";

/**
 * Concurrent buyers competing for the same scarce stock.
 *
 * Every other scenario runs in its own isolated environment, which is right for
 * measuring detection: a perturbation in one journey must not leak into another.
 * But isolation also means reservation races are never exercised. Here the
 * journeys deliberately *share* one merchant state, so several agents reserve,
 * approve and check out against the same eight units of coffee at once.
 *
 * The question this answers is narrow and important: can the merchant oversell?
 * Nothing else in the suite can tell you.
 */

export interface ConcurrentRunOptions {
  /** How many buyers run at once. */
  buyers?: number;
  /** Units of the contested product available. Fewer than buyers, by design. */
  stock?: number;
  /** The product every buyer competes for. */
  productId?: string;
  mutations?: MutationSet;
  seed?: string;
}

export interface BuyerOutcome {
  buyer: number;
  intentId: string;
  completed: boolean;
  note: string;
  violations: Violation[];
  /** Findings that indicate a merchant defect rather than contention. */
  defects: Violation[];
  orderConfirmed: boolean;
}

export interface ConcurrentRunResult {
  buyers: number;
  contestedProductId: string;
  openingStock: number;
  /** Buyers whose order was confirmed. Must not exceed opening stock. */
  ordersConfirmed: number;
  /** Buyers turned away because stock ran out. Contention, not a defect. */
  blockedForStock: number;
  finalAvailable: number;
  finalReserved: number;
  /** True when confirmed orders exceeded the stock that existed. */
  oversold: boolean;
  /** Payable orders beyond one for a single buyer intent. Must be zero. */
  duplicatePayableOrders: number;
  outcomes: BuyerOutcome[];
  /** Sum over all buyers of money the Guard prevented moving. */
  moneyAtRiskMinor: Minor;
  auditChainOk: boolean;
  auditEvents: number;
}

/**
 * Runs N buyers concurrently against one shared merchant state.
 *
 * Each buyer gets its own Guard so that violations are attributable, but they all
 * point at the same `MerchantState`, `HamperHubService` and audit log — which is
 * what creates genuine contention on reservations and stock.
 */
export async function runConcurrentBuyers(
  options: ConcurrentRunOptions = {},
): Promise<ConcurrentRunResult> {
  const buyers = options.buyers ?? 5;
  const productId = options.productId ?? "p-coffee-arabica";
  const stock = options.stock ?? 3;

  // One shared environment: shared catalog, inventory, service and audit log.
  const env = createEnvironment({
    mutations: options.mutations ?? MutationSet.fixed(),
    seed: options.seed ?? "concurrent",
  });

  env.state.setStock(productId, stock, `contended stock for ${buyers} buyers`);

  const results = await Promise.all(
    Array.from({ length: buyers }, (_, index) =>
      runOneBuyer(env, index + 1, productId),
    ),
  );

  const inventory = env.state.requireInventory(productId);
  const ordersConfirmed = results.filter((r) => r.orderConfirmed).length;
  const chain = env.audit.verify();

  return {
    buyers,
    contestedProductId: productId,
    openingStock: stock,
    ordersConfirmed,
    blockedForStock: results.filter(
      (r) => !r.completed && /stock|inventory|reserve/i.test(r.note),
    ).length,
    finalAvailable: inventory.available,
    finalReserved: inventory.reserved,
    oversold: ordersConfirmed > stock,
    duplicatePayableOrders: countDuplicatePayableOrders(env),
    outcomes: results,
    moneyAtRiskMinor: results.reduce(
      (sum, r) => sum + r.violations.reduce((s, v) => s + v.moneyAtRiskMinor, 0),
      0,
    ),
    auditChainOk: chain.ok,
    auditEvents: env.audit.all().length,
  };
}

async function runOneBuyer(
  env: Environment,
  buyer: number,
  productId: string,
): Promise<BuyerOutcome> {
  // A dedicated Guard per buyer, sharing the merchant state. Violations stay
  // attributable to the buyer that caused them.
  const guard = env.guard.forkForConcurrentBuyer();

  const intent = createIntent(env.ids, env.clock, {
    runId: `run_concurrent_b${buyer}`,
    utterance: `Buyer ${buyer}: one Arabica coffee gift, under ₹1,500.`,
    maxBudget: 1500,
  });
  guard.beginIntent(intent);

  const agent = new BuyerAgent({
    llm: new ScriptedLLM(),
    guard,
    systemSuffix: encodeStrategy({
      label: `concurrent buyer ${buyer}`,
      steps: [
        {
          tool: "create_bundle",
          args: {
            items: [
              { product_id: productId, quantity: 1 },
              { product_id: "p-card-handmade", quantity: 1 },
            ],
          },
        },
        { tool: "create_quote", args: { bundle_id: "$ref:bundle_id" } },
        {
          tool: "approve_quote",
          args: {
            quote_id: "$ref:quote_id",
            approved_amount: "$ref:total",
            confirmation_text: "Yes, go ahead.",
          },
        },
        {
          tool: "create_checkout",
          args: {
            quote_id: "$ref:quote_id",
            approval_receipt_id: "$ref:approval_receipt_id",
          },
        },
        {
          tool: "get_payment_status",
          args: { payment_attempt_id: "$ref:payment_attempt_id" },
        },
      ],
    }),
  });

  const run = await agent.run(intent);

  // Settle the payment and fulfil, so stock is actually committed and a
  // competing buyer can genuinely be starved.
  let orderConfirmed = false;
  const checkout = env.service
    .listCheckoutIntents(intent.id)
    .find((c) => c.status === "authorized");

  if (checkout) {
    const attempt = env.service.findPaymentAttemptForCheckout(checkout.id);
    if (attempt && env.fake) {
      await env.fake.simulatePayment(attempt.providerOrderId, "captured");
      await guard.callTool("get_payment_status", {
        payment_attempt_id: attempt.id,
      });
      orderConfirmed = guard.fulfillOrder(checkout.id).ok;
    }
  }

  const violations = [...guard.recordedViolations()];
  const last = run.transcript[run.transcript.length - 1];

  return {
    buyer,
    intentId: intent.id,
    completed: run.reachedCheckout,
    note:
      last && !last.ok
        ? `${last.tool}: ${last.summary}`
        : orderConfirmed
          ? "order confirmed"
          : run.finalMessage || "did not complete",
    violations,
    defects: integrationDefects(violations),
    orderConfirmed,
  };
}

/**
 * Payable orders beyond one for any single buyer intent.
 *
 * Two buyers each holding one order is correct contention; one buyer holding two
 * is a double charge.
 */
function countDuplicatePayableOrders(env: Environment): number {
  const byIntent = new Map<string, number>();
  for (const checkout of env.service.listCheckoutIntents()) {
    if (checkout.status !== "authorized" && checkout.status !== "fulfilled") {
      continue;
    }
    byIntent.set(checkout.intentId, (byIntent.get(checkout.intentId) ?? 0) + 1);
  }
  let duplicates = 0;
  for (const count of byIntent.values()) duplicates += Math.max(0, count - 1);
  return duplicates;
}
