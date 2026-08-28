/**
 * One payable order per buyer intent, enforced rather than observed.
 *
 * INV-IDEMPOTENCY already *detects* a second payable order. Detection is the wrong
 * guarantee for money: it means the duplicate existed long enough to be noticed, and
 * by then a provider order is open and a buyer can pay it twice.
 *
 * The merchant's existing defence is an in-memory scan —
 * `[...this.payments.values()].find(p => p.checkoutIntentId === id)`. That is correct
 * for exactly one process. A second process has its own Map, sees nothing, and both
 * create an order. No amount of locking fixes this on its own: a lock narrows the
 * window, a uniqueness claim removes it.
 *
 * So authorization takes a claim first. The claim is a row with a unique key; whoever
 * inserts it owns the right to create the payable order, and every other caller is
 * told who owns it instead. Two processes racing cannot both win, whatever either
 * believes about the other.
 *
 * Why not simply put the unique index on `checkout_intents`? Because that table is
 * written when a run finishes, from `persistSuite`. A constraint there fires long after
 * the money moved — it audits evidence, it does not prevent anything. This is a
 * separate live table written on the authorization path, which is the only place a
 * constraint can still say no.
 */

/** Outcome of trying to claim the sole payable order for an intent. */
export type ClaimResult =
  | { ok: true }
  /** Someone already owns it. `owner` is the checkout intent that got there first. */
  | { ok: false; owner: string };

export interface PayableOrderRegistry {
  readonly name: string;
  /**
   * Claims the sole payable order for `key`, returning who owns it if not you.
   *
   * Must be atomic. An implementation that reads then writes reintroduces exactly
   * the race this exists to close.
   */
  claim(key: string, owner: string): Promise<ClaimResult>;
  /**
   * Gives the claim back after a *definite* failure.
   *
   * Not called after a provider timeout. A timed-out create-order may well have
   * succeeded, so the intent stays claimed; releasing it there is precisely how a
   * double charge happens.
   */
  release(key: string, owner: string): Promise<void>;
}

/**
 * One process, one Map. The default, so nothing requires a database to be correct.
 *
 * Honest about its limits: this is the single-process guarantee the product already
 * had, expressed explicitly instead of emerging from the absence of `await`.
 */
export class InProcessPayableOrderRegistry implements PayableOrderRegistry {
  readonly name = "in-process";
  private claims = new Map<string, string>();

  async claim(key: string, owner: string): Promise<ClaimResult> {
    const existing = this.claims.get(key);
    // No await between the read and the write, so this is atomic in one process.
    if (existing !== undefined && existing !== owner) return { ok: false, owner: existing };
    this.claims.set(key, owner);
    return { ok: true };
  }

  async release(key: string, owner: string): Promise<void> {
    if (this.claims.get(key) === owner) this.claims.delete(key);
  }
}

/** The minimum a registry needs from a database client. */
export interface ClaimCapableDb {
  query<R = unknown>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

/**
 * Claims across every process pointed at the same database.
 *
 * The atomicity is the database's, not this code's: `insert ... on conflict do nothing`
 * either inserts a row or does not, and `returning` tells us which happened in the same
 * statement. There is no window between checking and claiming because there is no
 * check.
 */
export class PostgresPayableOrderRegistry implements PayableOrderRegistry {
  readonly name = "postgres";

  constructor(private readonly db: ClaimCapableDb) {}

  async claim(key: string, owner: string): Promise<ClaimResult> {
    const inserted = await this.db.query<{ owner: string }>(
      `insert into payable_order_claims (claim_key, owner_id, claimed_at)
            values ($1, $2, now())
       on conflict (claim_key) do nothing
         returning owner_id as owner`,
      [key, owner],
    );
    if (inserted.rows.length > 0) return { ok: true };

    // Lost the race, or this is the same owner retrying.
    const held = await this.db.query<{ owner: string }>(
      "select owner_id as owner from payable_order_claims where claim_key = $1",
      [key],
    );
    const current = held.rows[0]?.owner;
    if (current === undefined || current === owner) return { ok: true };
    return { ok: false, owner: current };
  }

  async release(key: string, owner: string): Promise<void> {
    await this.db.query(
      "delete from payable_order_claims where claim_key = $1 and owner_id = $2",
      [key, owner],
    );
  }
}

/**
 * The claim key for a buyer intent within one deployment scope.
 *
 * Scoped deliberately. The key cannot be the bare intent id: ids here are minted by a
 * seeded `IdFactory`, so a preflight that persists a vulnerable suite and then a fixed
 * suite can mint the same intent id twice, and a globally-unique claim would refuse the
 * second *legitimate* run. A real deployment has exactly one scope; each test run gets
 * a fresh one. Same mechanism, no false collisions.
 */
export function payableOrderKey(scope: string, intentId: string): string {
  return `${scope}:${intentId}`;
}
