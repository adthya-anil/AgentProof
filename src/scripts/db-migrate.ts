/**
 * Applies the AgentProof schema.
 *
 * Idempotent, so it is safe to run repeatedly. Exits zero and explains itself
 * when no database is configured, because persistence is optional.
 */
import { loadDotEnv } from "../lib/core/env.js";
import { Db, migrate, tableNames } from "../lib/db/client.js";
import { resolveDbConfig } from "../lib/db/config.js";

async function main(): Promise<void> {
  loadDotEnv();

  const config = resolveDbConfig();
  if (!config) {
    console.log("No database configured — nothing to migrate.\n");
    console.log("Set DATABASE_URL, or PGHOST/PGUSER/PGPASSWORD/PGDATABASE.");
    console.log("For a local server: npm run db:up\n");
    console.log(
      "AgentProof runs fully without a database; persistence only makes runs\n" +
        "survive the process that produced them.",
    );
    return;
  }

  console.log(`Migrating ${config.describe}`);
  const db = new Db(config);
  try {
    if (!(await db.isReachable())) {
      console.error(`\n✗ Cannot reach ${config.describe}`);
      console.error("  Is the server running? Try: npm run db:up");
      process.exit(1);
    }
    await migrate(db);
    const tables = await tableNames(db);
    console.log(`\n✓ Schema applied. ${tables.length} tables:`);
    for (const name of tables) console.log(`    ${name}`);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
