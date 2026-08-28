import { describe, expect, it } from "vitest";
import {
  InProcessLockManager,
  PostgresAdvisoryLockManager,
  stockKeys,
} from "../src/lib/core/lock.js";

/**
 * Mutual exclusion around check-and-hold.
 *
 * Reserving stock reads what is free and then decrements it. That was safe only by
 * accident: the method is fully synchronous and Node cannot preempt a synchronous
 * block. Measured before this change — five buyers racing for three units, three
 * succeed. The same logic with one `await` between the check and the act granted all
 * five.
 *
 * Two things were about to insert that await. Reading a merchant's catalogue over REST
 * is asynchronous by nature, and a second process removes the single-threaded
 * guarantee entirely. These tests pin the exclusion so it is a property rather than a
 * coincidence.
 */

describe("the race this exists to prevent", () => {
  /**
   * The bug, reproduced. Left unlocked, check-then-act across an await oversells —
   * and this is the shape the schema adapter is about to introduce.
   */
  it("oversells without a lock", async () => {
    let reserved = 0;
    const available = 3;

    const attempt = async (): Promise<boolean> => {
      if (available - reserved < 1) return false; // CHECK
      await new Promise((r) => setImmediate(r)); //  an API round-trip
      reserved += 1; //                              ACT
      return true;
    };

    const granted = (await Promise.all(Array.from({ length: 5 }, attempt))).filter(
      Boolean,
    ).length;

    expect(granted).toBe(5);
    expect(granted).toBeGreaterThan(available);
  });

  it("does not oversell with the lock held across both halves", async () => {
    const locks = new InProcessLockManager();
    let reserved = 0;
    const available = 3;

    const attempt = () =>
      locks.withLocks(["stock:coffee"], async () => {
        if (available - reserved < 1) return false;
        await new Promise((r) => setImmediate(r));
        reserved += 1;
        return true;
      });

    const granted = (await Promise.all(Array.from({ length: 5 }, attempt))).filter(
      Boolean,
    ).length;

    expect(granted).toBe(3);
    expect(reserved).toBe(3);
  });

  it("is the lock, not the absence of contention", async () => {
    // Same lock, same five callers, but locking a *different* key. If the previous
    // test passed because nothing actually raced, this one would pass too.
    const locks = new InProcessLockManager();
    let reserved = 0;

    const attempt = (i: number) =>
      locks.withLocks([`stock:unrelated-${i}`], async () => {
        if (3 - reserved < 1) return false;
        await new Promise((r) => setImmediate(r));
        reserved += 1;
        return true;
      });

    const granted = (
      await Promise.all(Array.from({ length: 5 }, (_, i) => attempt(i)))
    ).filter(Boolean).length;

    expect(granted).toBe(5); // oversold, because the keys never collided
  });
});

describe("in-process locking", () => {
  it("serialises holders of the same key", async () => {
    const locks = new InProcessLockManager();
    const order: string[] = [];

    const hold = (label: string) =>
      locks.withLocks(["k"], async () => {
        order.push(`${label}:enter`);
        await new Promise((r) => setImmediate(r));
        order.push(`${label}:exit`);
      });

    await Promise.all([hold("a"), hold("b")]);

    // No interleaving: one must fully finish before the other starts.
    expect(order).toEqual(["a:enter", "a:exit", "b:enter", "b:exit"]);
  });

  it("lets different keys proceed in parallel", async () => {
    // Buyers competing for coffee must not queue behind buyers competing for mugs.
    const locks = new InProcessLockManager();
    const order: string[] = [];

    const hold = (key: string, label: string) =>
      locks.withLocks([key], async () => {
        order.push(`${label}:enter`);
        await new Promise((r) => setImmediate(r));
        order.push(`${label}:exit`);
      });

    await Promise.all([hold("coffee", "a"), hold("mug", "b")]);

    // Interleaved, which is the point.
    expect(order).toEqual(["a:enter", "b:enter", "a:exit", "b:exit"]);
  });

  it("releases when the body throws", async () => {
    // A lock leaked on the error path deadlocks the next buyer for that product,
    // which is worse than the oversell it was added to prevent.
    const locks = new InProcessLockManager();

    await expect(
      locks.withLocks(["k"], async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Still acquirable.
    await expect(locks.withLocks(["k"], async () => "ok")).resolves.toBe("ok");
  });

  it("cannot deadlock on keys requested in opposite orders", async () => {
    /**
     * The classic two-lock deadlock. A bundle's product order is whatever the agent
     * typed, so one buyer asking for [coffee, mug] and another for [mug, coffee] is
     * routine rather than exotic. Sorting internally is what makes it impossible.
     */
    const locks = new InProcessLockManager();
    let done = 0;

    const a = locks.withLocks(["coffee", "mug"], async () => {
      await new Promise((r) => setImmediate(r));
      done += 1;
    });
    const b = locks.withLocks(["mug", "coffee"], async () => {
      await new Promise((r) => setImmediate(r));
      done += 1;
    });

    await Promise.all([a, b]);
    expect(done).toBe(2);
  });

  it("does not accumulate a lock entry per key ever used", async () => {
    // A slow leak nobody notices: one map entry per product ever reserved, on a
    // server that runs for weeks.
    const locks = new InProcessLockManager();
    for (let i = 0; i < 200; i += 1) {
      await locks.withLocks([`stock:p-${i}`], async () => undefined);
    }
    await new Promise((r) => setImmediate(r));

    const held = (locks as unknown as { tails: Map<string, unknown> }).tails;
    expect(held.size).toBe(0);
  });
});

describe("stock keys", () => {
  it("namespaces and de-duplicates", () => {
    expect(stockKeys([{ productId: "a" }, { productId: "a" }, { productId: "b" }])).toEqual(
      ["stock:a", "stock:b"],
    );
  });

  it("is the single source of the convention", () => {
    // Two code paths locking "p-coffee" and "stock:p-coffee" would each hold a lock
    // and neither would exclude the other.
    expect(stockKeys([{ productId: "p-coffee" }])[0]).toBe("stock:p-coffee");
  });
});

describe("postgres advisory locking", () => {
  it("takes one lock per key, sorted, inside a single transaction", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    let transactions = 0;

    const db = {
      async transaction<T>(
        fn: (c: {
          query: (sql: string, params?: unknown[]) => Promise<unknown>;
        }) => Promise<T>,
      ): Promise<T> {
        transactions += 1;
        return fn({
          async query(sql: string, params?: unknown[]) {
            calls.push({ sql, params });
            return undefined;
          },
        });
      },
    };

    const locks = new PostgresAdvisoryLockManager(db);
    const result = await locks.withLocks(["mug", "coffee"], async () => "done");

    expect(result).toBe("done");
    // One transaction, because pg_advisory_xact_lock releases when it ends —
    // including on crash, which a lock held in application memory does not.
    expect(transactions).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.sql.includes("pg_advisory_xact_lock"))).toBe(true);
    // Sorted, so opposite request orders cannot deadlock across processes either.
    expect(calls.map((c) => (c.params as string[])[0])).toEqual(["coffee", "mug"]);
  });
});
