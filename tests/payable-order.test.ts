import { describe, expect, it } from "vitest";
import {
  InProcessPayableOrderRegistry,
  PostgresPayableOrderRegistry,
  payableOrderKey,
  type ClaimCapableDb,
} from "../src/lib/core/payableOrder.js";

/**
 * One payable order per intent.
 *
 * INV-IDEMPOTENCY detects a duplicate. These tests are about refusing one, which is a
 * different guarantee: by the time a duplicate is detectable, a provider order is open
 * and a buyer can pay it twice.
 */

/** A fake that makes `insert ... on conflict do nothing` behave like Postgres. */
function fakeDb(): ClaimCapableDb & { rows: Map<string, string>; statements: string[] } {
  const rows = new Map<string, string>();
  const statements: string[] = [];
  return {
    rows,
    statements,
    async query<R>(sql: string, params: unknown[] = []): Promise<{ rows: R[] }> {
      statements.push(sql.replace(/\s+/g, " ").trim());
      const a = (params as string[])[0] ?? "";
      const b = (params as string[])[1] ?? "";
      if (sql.includes("insert into payable_order_claims")) {
        if (rows.has(a)) return { rows: [] as R[] }; // conflict: nothing returned
        rows.set(a, b);
        return { rows: [{ owner: b }] as R[] };
      }
      if (sql.startsWith("select")) {
        const owner = rows.get(a);
        return { rows: (owner ? [{ owner }] : []) as R[] };
      }
      if (sql.startsWith("delete")) {
        if (rows.get(a) === b) rows.delete(a);
        return { rows: [] as R[] };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
}

describe.each([
  ["in-process", () => new InProcessPayableOrderRegistry()],
  ["postgres", () => new PostgresPayableOrderRegistry(fakeDb())],
] as const)("%s payable-order registry", (_name, make) => {
  it("grants the first claim", async () => {
    const registry = make();
    await expect(registry.claim("k", "chk_1")).resolves.toEqual({ ok: true });
  });

  it("refuses a second owner and names the first", async () => {
    const registry = make();
    await registry.claim("k", "chk_1");
    // The name matters: the caller has to reconcile against a specific order, and
    // "already claimed" alone is not actionable.
    await expect(registry.claim("k", "chk_2")).resolves.toEqual({
      ok: false,
      owner: "chk_1",
    });
  });

  it("is idempotent for the same owner", async () => {
    // A retry by the rightful owner is not a duplicate.
    const registry = make();
    await registry.claim("k", "chk_1");
    await expect(registry.claim("k", "chk_1")).resolves.toEqual({ ok: true });
  });

  it("frees the key on release, so a legitimate retry can proceed", async () => {
    // After a declined card the intent must be payable again, or one bad card
    // number locks the buyer out permanently.
    const registry = make();
    await registry.claim("k", "chk_1");
    await registry.release("k", "chk_1");
    await expect(registry.claim("k", "chk_2")).resolves.toEqual({ ok: true });
  });

  it("ignores a release from someone who does not own the claim", async () => {
    // Otherwise a losing racer can strip the winner's claim and both proceed.
    const registry = make();
    await registry.claim("k", "chk_1");
    await registry.release("k", "chk_impostor");
    await expect(registry.claim("k", "chk_2")).resolves.toEqual({
      ok: false,
      owner: "chk_1",
    });
  });

  it("keeps different intents independent", async () => {
    const registry = make();
    await registry.claim("scope:intent_a", "chk_1");
    await expect(registry.claim("scope:intent_b", "chk_2")).resolves.toEqual({
      ok: true,
    });
  });

  it("admits exactly one winner from a concurrent stampede", async () => {
    const registry = make();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => registry.claim("k", `chk_${i}`)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    // Every loser is told the same owner, not a different one each time.
    const owners = new Set(results.filter((r) => !r.ok).map((r) => r.owner));
    expect(owners.size).toBe(1);
  });
});

describe("the claim is taken atomically, not read-then-written", () => {
  it("uses on-conflict-do-nothing rather than a select followed by an insert", async () => {
    const db = fakeDb();
    const registry = new PostgresPayableOrderRegistry(db);
    await registry.claim("k", "chk_1");

    // A select-then-insert implementation has a window between the two statements,
    // which is the whole bug. The winning path must be a single statement.
    expect(db.statements).toHaveLength(1);
    expect(db.statements[0]).toContain("on conflict (claim_key) do nothing");
    expect(db.statements[0]).toContain("returning");
  });

  it("only reads to find out who won, after already having lost", async () => {
    const db = fakeDb();
    const registry = new PostgresPayableOrderRegistry(db);
    await registry.claim("k", "chk_1");
    db.statements.length = 0;

    await registry.claim("k", "chk_2");
    expect(db.statements[0]).toContain("insert into payable_order_claims");
    expect(db.statements[1]).toContain("select owner_id");
  });
});

describe("claim scoping", () => {
  it("namespaces the intent id", () => {
    expect(payableOrderKey("deploy_1", "intent_a")).toBe("deploy_1:intent_a");
  });

  it("keeps identical intent ids in different scopes apart", async () => {
    /**
     * Not hypothetical. Intent ids come from a seeded IdFactory, so a preflight that
     * persists a vulnerable suite and then a fixed one mints the same intent id in
     * both. An unscoped claim would refuse the second, legitimate run.
     */
    const registry = new InProcessPayableOrderRegistry();
    const intentId = "intent_00000001";
    await registry.claim(payableOrderKey("vulnerable-run", intentId), "chk_1");
    await expect(
      registry.claim(payableOrderKey("fixed-run", intentId), "chk_1"),
    ).resolves.toEqual({ ok: true });
  });

  it("still collides within one scope, which is the point", async () => {
    const registry = new InProcessPayableOrderRegistry();
    await registry.claim(payableOrderKey("one-deployment", "intent_a"), "chk_1");
    await expect(
      registry.claim(payableOrderKey("one-deployment", "intent_a"), "chk_2"),
    ).resolves.toEqual({ ok: false, owner: "chk_1" });
  });
});
