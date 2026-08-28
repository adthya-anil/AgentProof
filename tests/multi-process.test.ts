import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

/**
 * Where the forked child should import `pg` from, as a URL.
 *
 * `require.resolve` returns a filesystem path, and a bare absolute path is only a valid
 * ESM specifier on POSIX. On Windows it is `C:\\Users\\...`, which Node's loader
 * rejects outright — so both tests in this file would fail on a Windows machine with an
 * error that looks like a lost race rather than a bad import. A `file://` URL is correct
 * on every platform.
 */
const PG_SPECIFIER = JSON.stringify(pathToFileURL(require.resolve("pg")).href);

/**
 * Concurrency across processes, not across promises.
 *
 * Every concurrency test in this suite until now used `Promise.all` in one process.
 * That can demonstrate interleaving across `await`, and it did — but it cannot
 * demonstrate the failure the product actually claims to have fixed, because a single
 * process shares one Map and one event loop. If the guarantee is "two processes cannot
 * both create a payable order", the test has to be two processes.
 *
 * So these fork real `node` children against one database. Skipped without
 * `DATABASE_URL`, because a test that silently passes when the thing it tests is
 * absent is worse than no test.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

/** Runs `source` in N separate node processes at once, returning their stdout. */
async function inParallelProcesses(
  source: string,
  count: number,
): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "agentproof-mp-"));
  const file = join(dir, "child.mjs");
  writeFileSync(file, source);

  const children = Array.from({ length: count }, () =>
    run(process.execPath, [file], {
      env: { ...process.env, DATABASE_URL },
      timeout: 30_000,
    })
      .then((r) => r.stdout.trim())
      .catch((e: { stdout?: string; stderr?: string }) =>
        (e.stdout ?? `ERROR ${e.stderr ?? "unknown"}`).trim(),
      ),
  );
  return Promise.all(children);
}

/**
 * A child that races for one claim key.
 *
 * Talks to Postgres with the same SQL as PostgresPayableOrderRegistry. Written inline
 * rather than importing the TypeScript, because a forked plain-node child cannot load
 * the project's TS without a build step, and adding one here would test the build
 * rather than the claim.
 */
const CLAIMANT = `
import pg from ${PG_SPECIFIER};
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const owner = "chk_" + process.pid;
// Stagger slightly so the processes genuinely overlap rather than queue.
await new Promise((r) => setTimeout(r, Math.random() * 50));
const inserted = await client.query(
  \`insert into payable_order_claims (claim_key, owner_id, claimed_at)
        values ($1, $2, now())
   on conflict (claim_key) do nothing
     returning owner_id\`,
  [process.env.CLAIM_KEY ?? "mp:intent_race", owner],
);
console.log(inserted.rows.length > 0 ? "WON " + owner : "LOST");
await client.end();
`;

describeDb("two processes, one database", () => {
  it("admits exactly one payable order when four processes race", async () => {
    const key = `mp:intent_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const outputs = await inParallelProcesses(
      CLAIMANT.replace("mp:intent_race", key),
      4,
    );

    const winners = outputs.filter((o) => o.startsWith("WON"));
    const losers = outputs.filter((o) => o === "LOST");

    expect(outputs).toHaveLength(4);
    // The guarantee. Four independent processes, one payable order.
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(3);
  }, 60_000);

  it("shows the same four processes would all have won without the constraint", async () => {
    /**
     * The control. Same four processes, same overlap, but each checks-then-inserts
     * against a table with no unique key — which is what the in-memory scan amounts to
     * once there is more than one process. If this also produced one winner, the test
     * above would be proving nothing.
     */
    const key = `mp:control_${Date.now()}`;

    /**
     * Create the unconstrained table first, in one process.
     *
     * Four concurrent `create table if not exists` calls can genuinely collide in
     * Postgres — the existence check and the creation are not atomic against each
     * other, and the losers raise a duplicate-key error on an internal catalogue
     * index. That made this test fail for a reason that had nothing to do with what
     * it measures.
     */
    await inParallelProcesses(
      `
import pg from ${PG_SPECIFIER};
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
await client.query("create table if not exists mp_control (claim_key text, owner_id text)");
console.log("ready");
await client.end();
`,
      1,
    );

    const unconstrained = `
import pg from ${PG_SPECIFIER};
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const owner = "chk_" + process.pid;
await new Promise((r) => setTimeout(r, Math.random() * 50));
// CHECK, then a gap, then ACT — no constraint to stop either half.
const seen = await client.query("select 1 from mp_control where claim_key = $1", ["${key}"]);
await new Promise((r) => setTimeout(r, 60));
if (seen.rows.length === 0) {
  await client.query("insert into mp_control (claim_key, owner_id) values ($1,$2)", ["${key}", owner]);
  console.log("WON " + owner);
} else {
  console.log("LOST");
}
await client.end();
`;
    const outputs = await inParallelProcesses(unconstrained, 4);
    const winners = outputs.filter((o) => o.startsWith("WON"));

    // More than one winner: the duplicate the constraint prevents, reproduced.
    expect(winners.length).toBeGreaterThan(1);
  }, 60_000);
});
