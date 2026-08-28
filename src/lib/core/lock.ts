/**
 * Mutual exclusion around check-and-hold.
 *
 * Reserving stock is check-then-act: read what is free, then decrement it. That is
 * safe today only by accident — the method is fully synchronous, and Node cannot
 * preempt a synchronous block. Measured: five buyers racing for three units, three
 * succeed. Insert one `await` between the check and the act and all five succeed,
 * overselling by two.
 *
 * Two things are about to insert that `await`. Reading a merchant's catalogue over
 * REST or GraphQL is asynchronous by nature, and more than one process removes the
 * single-threaded guarantee entirely. So the exclusion has to be explicit rather than
 * emergent.
 *
 * Two implementations. In-process is a promise queue per key and is enough for one
 * Node process. Postgres advisory locks serialise across every process pointed at the
 * same database, which is what a real deployment needs.
 *
 * Note what this is *not* for: preventing a second payable order. A lock narrows the
 * window; a unique constraint removes it. Money-critical uniqueness belongs in the
 * schema, and does — see `one_payable_order_per_intent`. This exists for the
 * check-and-hold that cannot be expressed as a constraint.
 */
export interface LockManager {
  readonly name: string;
  /**
   * Runs `fn` with every named key held, releasing them afterwards even on throw.
   *
   * Keys are sorted internally before acquisition. Two callers asking for
   * `[coffee, mug]` and `[mug, coffee]` would otherwise be able to deadlock, and a
   * bundle's product order is decided by whatever the agent happened to type.
   */
  withLocks<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T>;
}

/**
 * One process, one lock table.
 *
 * A promise chain per key: each waiter appends itself to the tail and awaits the
 * previous holder. Enough for a single Node process, and the default so nothing
 * requires a database to be correct.
 */
export class InProcessLockManager implements LockManager {
  readonly name = "in-process";
  private tails = new Map<string, Promise<void>>();

  async withLocks<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(keys)].sort();
    const releases: Array<() => void> = [];

    for (const key of ordered) {
      const previous = this.tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Chained on the previous holder, so waiters queue rather than spin.
      this.tails.set(
        key,
        previous.then(() => mine),
      );
      await previous;
      releases.push(release);
    }

    try {
      return await fn();
    } finally {
      // Reverse order, mirroring acquisition.
      for (const release of releases.reverse()) release();
      this.prune(ordered);
    }
  }

  /**
   * Drops keys nobody is waiting on.
   *
   * Without this the map grows one entry per product ever reserved, which for a
   * long-lived server is a slow leak of exactly the kind nobody notices.
   */
  private prune(keys: readonly string[]): void {
    for (const key of keys) {
      const tail = this.tails.get(key);
      if (!tail) continue;
      void tail.then(() => {
        if (this.tails.get(key) === tail) this.tails.delete(key);
      });
    }
  }
}

/** The minimum a lock manager needs from a database client. */
export interface LockCapableDb {
  transaction<T>(
    fn: (client: {
      query: (sql: string, params?: unknown[]) => Promise<unknown>;
    }) => Promise<T>,
  ): Promise<T>;
}

/**
 * Serialises across processes using Postgres advisory locks.
 *
 * `pg_advisory_xact_lock` is taken inside a transaction and released when that
 * transaction ends — including on crash, which is the property that matters. A lock
 * held in application memory survives a process dying; this one cannot.
 *
 * Chosen over Redis deliberately. Redlock's correctness under clock skew and GC pauses
 * is contested, and there is no reason to introduce a second datastore and a disputed
 * algorithm when the database already holding the money-critical rows offers exact
 * semantics. Redis would earn its place only for locking across services that share no
 * database.
 */
export class PostgresAdvisoryLockManager implements LockManager {
  readonly name = "postgres-advisory";

  constructor(private readonly db: LockCapableDb) {}

  async withLocks<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(keys)].sort();

    return this.db.transaction(async (client) => {
      for (const key of ordered) {
        // hashtext maps a key to the bigint the advisory lock functions take. A
        // collision would over-serialise two unrelated keys, which is slower but
        // never wrong — the failure mode is contention, not oversell.
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [key]);
      }
      return fn();
    });
  }
}

/**
 * The stock keys a set of line items touches.
 *
 * Exported so callers cannot invent their own convention: two code paths locking
 * `"p-coffee"` and `"stock:p-coffee"` for the same product would each hold a lock and
 * neither would exclude the other.
 */
export function stockKeys(
  items: readonly { productId: string }[],
): string[] {
  return [...new Set(items.map((item) => `stock:${item.productId}`))];
}
