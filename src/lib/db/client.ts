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
    return (await this.probe()).ok;
  }

  /**
   * Reachability with a reason.
   *
   * `isReachable` alone produced a genuinely misleading message: a running server
   * with no `agentproof` database reported "cannot reach — is the server
   * running?", sending you to look at the one thing that was fine. Postgres says
   * exactly what is wrong (`3D000`, invalid_catalog_name), so pass it on.
   */
  async probe(): Promise<{ ok: boolean; reason?: string; hint?: string }> {
    try {
      await this.query("select 1");
      return { ok: true };
    } catch (error) {
      const code = (error as { code?: string }).code;
      const message = error instanceof Error ? error.message : String(error);

      if (code === "3D000") {
        return {
          ok: false,
          reason: message,
          hint:
            "The server is running but that database does not exist. Create it " +
            "first — in pgAdmin: right-click Databases → Create → Database, " +
            'name it "agentproof". Or: createdb -U postgres agentproof',
        };
      }
      if (code === "28P01" || code === "28000") {
        return {
          ok: false,
          reason: message,
          hint: "The user or password in DATABASE_URL was rejected by the server.",
        };
      }
      if (code === "ECONNREFUSED" || code === "EHOSTUNREACH") {
        return {
          ok: false,
          reason: message,
          hint:
            "Nothing is listening there. Check the host and port, and that " +
            "PostgreSQL is actually started.",
        };
      }
      return { ok: false, reason: message };
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
