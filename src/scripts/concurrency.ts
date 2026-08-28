/**
 * Concurrent buyers racing for scarce stock.
 *
 * Five agents chase three units of coffee at the same time, against one shared
 * merchant state. The pass condition is narrow: confirmed orders must never
 * exceed the stock that existed, and no single buyer may end up with two payable
 * orders. Losing buyers being turned away is the correct outcome, not a failure.
 */
import { loadDotEnv } from "../lib/core/env.js";
import { formatMinor } from "../lib/core/money.js";
import { MutationSet } from "../lib/hamperhub/mutations.js";
import { runConcurrentBuyers } from "../lib/runner/concurrent.js";

async function main(): Promise<void> {
  loadDotEnv();

  console.log("AgentProof — concurrent buyers competing for scarce stock\n");

  let failures = 0;

  for (const variant of ["fixed", "vulnerable"] as const) {
    const result = await runConcurrentBuyers({
      buyers: 5,
      stock: 3,
      mutations:
        variant === "fixed" ? MutationSet.fixed() : MutationSet.vulnerable(),
    });

    console.log(`${"═".repeat(70)}`);
    console.log(`${variant.toUpperCase()} integration`);
    console.log(
      `  ${result.buyers} buyers · ${result.openingStock} units of ` +
        `${result.contestedProductId}\n`,
    );

    for (const outcome of result.outcomes) {
      const mark = outcome.orderConfirmed
        ? "✓"
        : outcome.defects.length > 0
          ? "✗"
          : "•";
      console.log(
        `  ${mark} buyer ${outcome.buyer}  ${
          outcome.orderConfirmed ? "confirmed" : "not confirmed"
        }  ${outcome.note.slice(0, 74)}`,
      );
      for (const defect of outcome.defects) {
        console.log(`        defect [${defect.invariantId}] ${defect.message.slice(0, 90)}`);
      }
    }

    console.log("");
    console.log(`  Orders confirmed:          ${result.ordersConfirmed}`);
    console.log(`  Turned away for stock:     ${result.blockedForStock}`);
    console.log(
      `  Stock after:               available ${result.finalAvailable}, ` +
        `reserved ${result.finalReserved}`,
    );
    console.log(`  Oversold:                  ${result.oversold ? "YES" : "no"}`);
    console.log(
      `  Duplicate payable orders:  ${result.duplicatePayableOrders}`,
    );
    console.log(
      `  Money at risk (prevented): ${formatMinor(result.moneyAtRiskMinor)}`,
    );
    console.log(
      `  Audit chain:               ${
        result.auditChainOk ? "verified" : "BROKEN"
      } (${result.auditEvents} events)\n`,
    );

    // The invariants that matter under contention.
    if (result.oversold) {
      console.error(
        `  ✗ OVERSOLD: ${result.ordersConfirmed} orders against ` +
          `${result.openingStock} units.`,
      );
      failures += 1;
    }
    if (result.duplicatePayableOrders > 0) {
      console.error(
        `  ✗ ${result.duplicatePayableOrders} duplicate payable order(s).`,
      );
      failures += 1;
    }
    if (!result.auditChainOk) {
      console.error("  ✗ Audit chain broken under concurrent writes.");
      failures += 1;
    }
    if (result.ordersConfirmed === 0) {
      // A Guard that blocks everyone trivially never oversells. That is not a
      // pass; it would mean contention had made the merchant unusable.
      console.error("  ✗ No buyer succeeded — contention starved every buyer.");
      failures += 1;
    }
  }

  console.log("═".repeat(70));
  console.log(
    "\nWhat this does and does not prove.\n" +
      "  Journeys here genuinely interleave — they share one merchant state and\n" +
      "  suspend at every await — so allocation, reservation and commit are\n" +
      "  exercised out of order. That is what catches an allocator that double-\n" +
      "  promises stock.\n" +
      "\n" +
      "  The two runs above are identical, and that is expected rather than a\n" +
      "  finding. None of the eight seeded defects touches allocation, so there is\n" +
      "  no mutation that could make the vulnerable integration oversell. Both are\n" +
      "  printed because the numbers should match; read them as one result, not a\n" +
      "  comparison.\n" +
      "\n" +
      "  This demo also cannot fail on overselling, so it cannot be the evidence\n" +
      "  that the locking works. Check-and-hold is synchronous inside one process,\n" +
      "  so no interleaving can split it whether a lock is held or not. What does\n" +
      "  demonstrate it:\n" +
      "    tests/locks.test.ts          the same check-and-hold with one await\n" +
      "                                between the halves grants all five buyers\n" +
      "                                three units. The lock closes it, and a\n" +
      "                                control locking a different key oversells\n" +
      "                                again — so the pass is the lock, not luck.\n" +
      "    tests/multi-process.test.ts  four real OS processes, one database, one\n" +
      "                                payable order. The same four without the\n" +
      "                                unique constraint produce four winners.\n" +
      "                                Needs DATABASE_URL; skipped without it.",
  );

  if (failures > 0) {
    console.error(`\n✗ ${failures} concurrency check(s) failed.`);
    process.exit(1);
  }
  console.log(
    "\n✓ No overselling, no duplicate payable orders, audit chain intact\n" +
      "  under interleaved load, and at least one buyer still succeeded.",
  );
}

main().catch((error) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
