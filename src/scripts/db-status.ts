/**
 * Reports what is stored: row counts, recent suites, and whether the persisted
 * hash chains still verify.
 */
import { loadDotEnv } from "../lib/core/env.js";
import { formatMinor } from "../lib/core/money.js";
import { Db } from "../lib/db/client.js";
import { resolveDbConfig } from "../lib/db/config.js";
import {
  listSuites,
  tableCounts,
  verifyStoredChains,
} from "../lib/db/queries.js";

async function main(): Promise<void> {
  loadDotEnv();

  const config = resolveDbConfig();
  if (!config) {
    console.log("No database configured. Set DATABASE_URL or run: npm run db:up");
    return;
  }

  const db = new Db(config);
  try {
    const probe = await db.probe();
    if (!probe.ok) {
      console.error(`✗ ${config.describe}`);
      if (probe.reason) console.error(`  ${probe.reason}`);
      if (probe.hint) console.error(`  ${probe.hint}`);
      process.exit(1);
    }
    console.log(`AgentProof store — ${config.describe}\n`);

    console.log("Row counts:");
    for (const { table, rows } of await tableCounts(db)) {
      console.log(`  ${table.padEnd(18)} ${String(rows).padStart(6)}`);
    }

    const suites = await listSuites(db, 10);
    console.log(`\nRecent suites (${suites.length}):`);
    if (suites.length === 0) {
      console.log("  none yet — run: npm run demo:preflight");
    }
    for (const s of suites) {
      console.log(
        `  ${s.created_at.toISOString().slice(0, 19)}  ` +
          `${s.integration_variant.padEnd(11)} ` +
          `${String(s.journeys).padStart(2)} journeys  ` +
          `unsafe=${s.unsafe_violations} escapes=${s.money_critical_escapes}  ` +
          `${formatMinor(Number(s.money_at_risk_minor))}  ${s.readiness}`,
      );
    }

    const chains = await verifyStoredChains(db);
    const broken = chains.filter((c) => !c.ok);
    console.log(`\nPersisted hash chains: ${chains.length} checked`);
    if (broken.length === 0) {
      console.log("  ✓ all verify");
    } else {
      console.log(`  ✗ ${broken.length} broken:`);
      for (const b of broken) {
        console.log(`      ${b.testRunId} at seq ${b.brokenAtSeq}`);
      }
      process.exit(1);
    }
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
