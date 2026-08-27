import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { type DbConfig, type EnvLike, resolveDbConfig } from "./config.js";

/**
 * Thin pooled Postgres client.
 *
 * Deliberately not an ORM. The schema is small, the queries are inserts of
 * already-computed values, and hand-written SQL keeps the money columns visibly
 * BIGINT paise rather than hidden behind a mapping layer.
 */
export class Db {
  private readonly pool: Pool;

  constructor(readonly config: DbConfig) {
    this.pool = new Pool({
      connectionString: config.connectionString,
      // A preflight suite writes in a short burst then stops; a large idle pool
      // would just hold connections open.
      max: 4,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 10_000,
    });
    // Without this an unexpected server disconnect becomes an unhandled error
    // event and takes the process down.
    this.pool.on("error", () => {});
  }

  static fromEnv(env: EnvLike = process.env): Db | null {
    const config = resolveDbConfig(env);
    return config ? new Db(config) : null;
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const result = await this.pool.query<T>(sql, params);
    return result.rows;
  }

  /** Runs `fn` inside a transaction, rolling back on any error. */
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await fn(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The connection is already broken; the original error is what matters.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** True when the server answers. Used to decide whether to persist at all. */
  async isReachable(): Promise<boolean> {
    try {
      await this.query("select 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Applies the schema.
 *
 * The DDL is written with `IF NOT EXISTS` throughout and runs inside one
 * transaction, so this is idempotent: safe on every boot, and safe to run
 * concurrently from two processes.
 */
export async function migrate(db: Db): Promise<{ applied: boolean }> {
  const sql = readFileSync(resolve(here, "schema.sql"), "utf8");
  await db.transaction(async (client) => {
    await client.query(sql);
  });
  return { applied: true };
}

export async function tableNames(db: Db): Promise<string[]> {
  const rows = await db.query<{ table_name: string }>(
    `select table_name from information_schema.tables
     where table_schema = 'public' order by table_name`,
  );
  return rows.map((r) => r.table_name);
}
