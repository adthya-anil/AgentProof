/**
 * Database configuration resolution.
 *
 * Persistence is strictly optional. AgentProof's engine is deterministic and
 * in-memory; a database makes runs survive the process that produced them, which
 * matters for a reviewer coming back later, but nothing depends on it. So this
 * returns `null` rather than throwing when no database is configured, and every
 * caller must cope with that. It is why CI stays green with no server.
 *
 * Accepts either a single `DATABASE_URL` or discrete `PG*` variables, because a
 * developer running pgAdmin locally will have the latter to hand.
 */
export interface DbConfig {
  connectionString: string;
  /** Redacted form, safe to log or render in a dashboard. */
  describe: string;
}

/** Just the variables we read, so tests can pass a plain object. */
export type EnvLike = Record<string, string | undefined>;

export function resolveDbConfig(env: EnvLike = process.env): DbConfig | null {
  const url = env.DATABASE_URL?.trim();
  if (url) {
    return { connectionString: url, describe: redactUrl(url) };
  }

  // Discrete variables. A host is the minimum signal that a database is wanted;
  // defaulting a host would silently try to reach localhost in environments that
  // have no database at all.
  const host = env.PGHOST?.trim();
  if (!host) return null;

  const user = env.PGUSER?.trim() || "postgres";
  const password = env.PGPASSWORD ?? "";
  const database = env.PGDATABASE?.trim() || "agentproof";
  const port = env.PGPORT?.trim() || "5432";

  // A host that looks like a path is a Unix socket directory, which belongs in
  // the query string rather than the authority section.
  const isSocket = host.startsWith("/");
  const auth = password
    ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}`
    : encodeURIComponent(user);

  const connectionString = isSocket
    ? `postgres://${auth}@/${database}?host=${host}`
    : `postgres://${auth}@${host}:${port}/${database}`;

  return { connectionString, describe: redactUrl(connectionString) };
}

export function redactUrl(url: string): string {
  return url.replace(/\/\/([^:/@]+):[^@]*@/, "//$1:****@");
}

/** True when a database is configured. Cheap enough to call from anywhere. */
export function isDbConfigured(env: EnvLike = process.env): boolean {
  return resolveDbConfig(env) !== null;
}
