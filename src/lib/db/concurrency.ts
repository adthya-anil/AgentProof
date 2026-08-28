import {
  type LockManager,
  PostgresAdvisoryLockManager,
} from "../core/lock.js";
import {
  type PayableOrderRegistry,
  PostgresPayableOrderRegistry,
} from "../core/payableOrder.js";
import type { Db } from "./client.js";

/**
 * Adapts `Db` to the two narrow interfaces the concurrency primitives need.
 *
 * `lock.ts` and `payableOrder.ts` live under `core/` and deliberately do not import
 * `Db`. They declare the smallest surface they use — a transaction, or a query that
 * returns rows — so they stay unit-testable against a fake and carry no dependency on
 * `pg`. The cost is this shim, which is the whole of the coupling in one place.
 *
 * `Db.query` returns rows directly while the registry expects `{ rows }`, matching
 * `pg`'s own result shape. Reshaped here rather than changing either side.
 */
export function concurrencyBackendsFromDb(db: Db): {
  locks: LockManager;
  payableOrders: PayableOrderRegistry;
} {
  return {
    locks: new PostgresAdvisoryLockManager({
      transaction: (fn) => db.transaction(fn),
    }),
    payableOrders: new PostgresPayableOrderRegistry({
      query: async <R>(sql: string, params?: unknown[]) => ({
        rows: (await db.query(sql, params ?? [])) as R[],
      }),
    }),
  };
}
