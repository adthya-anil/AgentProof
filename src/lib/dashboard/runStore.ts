import { randomUUID } from "node:crypto";
import { Db, migrate } from "../db/client.js";
import {
  latestSuiteFor,
  recentSuiteSnapshots,
  type StoredSuiteSnapshot,
} from "../db/queries.js";
import { persistSuite } from "../db/repository.js";
import type { Policy } from "../policy/schema.js";
import type { SuiteResult } from "../runner/run.js";
import type { IntegrationVariant } from "./data.js";

/**
 * Holds completed preflight runs for the dashboard to read.
 *
 * The report pages used to execute a suite on every request. That was fine when
 * a journey took milliseconds, but it is wrong in two ways once a real model is
 * driving: loading a page silently spends real money and minutes, and nobody
 * asked for it. A preflight run is an action a developer takes deliberately.
 *
 * So pages read from here, and runs are triggered explicitly. This is an
 * in-memory cache of the most recent run per variant, mirrored to Postgres when
 * one is configured — the cache keeps the dashboard instant, and the database is
 * what makes a run outlive the process.
 */

export interface StoredRun {
  id: string;
  variant: IntegrationVariant;
  suite: SuiteResult;
  startedAt: string;
  finishedAt: string;
  /** Model that generated the scenarios and drove the agents. */
  model: string;
  modelIsReal: boolean;
  paymentAdapter: string;
  regressionCount: number;
  perturbationCount: number;
  /** Regression goals replayed by a live agent with no scripted steps. */
  liveCount: number;
  generatedCount: number;
  /** Set when the run was mirrored to Postgres. */
  persistedSuiteId: string | null;
}

/**
 * Module-level state. Next.js keeps one Node process per server, so this
 * survives navigation between pages, which is all it needs to do.
 */
const latest = new Map<IntegrationVariant, StoredRun>();
const history: StoredRun[] = [];

/** Synchronous cache read. Null when this process has not run that variant. */
export function getCachedRun(variant: IntegrationVariant): StoredRun | null {
  return latest.get(variant) ?? null;
}

/**
 * The most recent run for a variant, from cache or from Postgres.
 *
 * The cache alone was the one place this product delivered less than it claimed:
 * runs persisted correctly, the read queries existed, and restarting the server
 * still showed "no run yet" while the rows sat in the database. A report that
 * evaporates when the process restarts is not really a stored report.
 *
 * Cache first because it is exact and instant; the database is consulted only on a
 * miss, and what it returns is cached so the next page load is instant too.
 */
export async function getLatestRun(
  variant: IntegrationVariant,
): Promise<StoredRun | null> {
  const cached = latest.get(variant);
  if (cached) return cached;

  const hydrated = await hydrateFromDb(variant);
  if (hydrated) latest.set(variant, hydrated);
  return hydrated;
}

export function getRunHistory(limit = 10): StoredRun[] {
  return history.slice(0, limit);
}

/**
 * Recent runs, from this process and from the database, newest first.
 *
 * Merged rather than one or the other: the in-memory copies are exact, and the
 * stored ones are what survived a restart. De-duplicated by persisted suite id so a
 * run that is in both does not appear twice.
 */
export async function getRunHistoryWithStored(
  limit = 10,
): Promise<StoredRun[]> {
  const merged = [...history];
  const seen = new Set(
    history.map((run) => run.persistedSuiteId).filter(Boolean) as string[],
  );

  const db = Db.fromEnv();
  if (db) {
    try {
      if (await db.isReachable()) {
        for (const row of await recentSuiteSnapshots(db, limit)) {
          if (seen.has(row.id)) continue;
          const run = toStoredRun(row);
          if (run) merged.push(run);
        }
      }
    } catch {
      // History is a convenience. Never let it break a page.
    } finally {
      await db.close();
    }
  }

  return merged
    .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))
    .slice(0, limit);
}

export async function hasAnyRun(): Promise<boolean> {
  if (latest.size > 0) return true;
  return (await getLatestRun("vulnerable")) !== null ||
    (await getLatestRun("fixed")) !== null;
}

async function hydrateFromDb(
  variant: IntegrationVariant,
): Promise<StoredRun | null> {
  const db = Db.fromEnv();
  if (!db) return null;

  try {
    if (!(await db.isReachable())) return null;
    const row = await latestSuiteFor(db, variant);
    return row ? toStoredRun(row) : null;
  } catch {
    // An unreadable database is a dashboard that shows no stored run, not a
    // dashboard that fails to render.
    return null;
  } finally {
    await db.close();
  }
}

/**
 * Rebuilds a StoredRun from a snapshot row.
 *
 * Returns null on anything unparseable rather than throwing: a corrupt or
 * older-format row should mean "no stored run", never a broken page.
 */
function toStoredRun(row: StoredSuiteSnapshot): StoredRun | null {
  const suite = reviveSuite(row.result);
  if (!suite) return null;

  const finishedAt = row.created_at.toISOString();
  return {
    id: row.id,
    variant: row.integration_variant === "fixed" ? "fixed" : "vulnerable",
    suite,
    // The snapshot records a duration but not a start instant, so it is derived
    // rather than invented.
    startedAt: new Date(
      row.created_at.getTime() - (row.duration_ms ?? 0),
    ).toISOString(),
    finishedAt,
    model: row.generator_model ?? "unknown",
    modelIsReal: row.generator_is_real,
    paymentAdapter: row.payment_adapter ?? "unknown",
    // Composition counts are not stored separately; derive them from the journeys
    // so the report header stays truthful rather than showing zeroes.
    regressionCount: suite.journeys.filter((j) =>
      j.scenarioId.startsWith("reg-"),
    ).length,
    perturbationCount: suite.journeys.filter((j) =>
      j.scenarioId.startsWith("pert-"),
    ).length,
    liveCount: suite.journeys.filter((j) => j.scenarioId.startsWith("live-"))
      .length,
    generatedCount: suite.journeys.filter((j) => j.scenarioId.startsWith("gen-"))
      .length,
    persistedSuiteId: row.id,
  };
}

/**
 * Restores a SuiteResult from JSON.
 *
 * `AuditEvent.at` is a Date, and a JSON round-trip turns it into a string. Left
 * unrevived, every replay page would call `.toISOString()` on a string and throw —
 * so the timestamps are restored explicitly rather than trusted to survive.
 */
function reviveSuite(raw: unknown): SuiteResult | null {
  if (!raw || typeof raw !== "object") return null;
  const suite = raw as SuiteResult;
  if (!Array.isArray(suite.journeys)) return null;

  for (const journey of suite.journeys) {
    if (!Array.isArray(journey.auditTrail)) continue;
    for (const event of journey.auditTrail) {
      if (typeof event.at === "string") {
        (event as { at: Date }).at = new Date(event.at);
      }
    }
  }
  return suite;
}

export interface RecordRunInput {
  variant: IntegrationVariant;
  suite: SuiteResult;
  startedAt: number;
  model: string;
  modelIsReal: boolean;
  paymentAdapter: string;
  regressionCount: number;
  perturbationCount: number;
  liveCount: number;
  generatedCount: number;
  policy: Policy;
}

/**
 * Records a completed run and mirrors it to Postgres when available.
 *
 * Persistence failures are swallowed deliberately: the run happened, and losing
 * the database copy must not lose the result the developer is waiting to read.
 */
export async function recordRun(input: RecordRunInput): Promise<StoredRun> {
  const stored: StoredRun = {
    id: randomUUID(),
    variant: input.variant,
    suite: input.suite,
    startedAt: new Date(input.startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    model: input.model,
    modelIsReal: input.modelIsReal,
    paymentAdapter: input.paymentAdapter,
    regressionCount: input.regressionCount,
    perturbationCount: input.perturbationCount,
    liveCount: input.liveCount,
    generatedCount: input.generatedCount,
    persistedSuiteId: null,
  };

  const db = Db.fromEnv();
  if (db) {
    try {
      if (await db.isReachable()) {
        await migrate(db);
        const { suiteId } = await persistSuite(db, input.suite, {
          policy: input.policy,
          policyVersion: input.suite.policyVersion,
          integrationVariant: input.variant,
          generatorModel: input.model,
          generatorIsReal: input.modelIsReal,
          paymentAdapter: input.paymentAdapter,
        });
        stored.persistedSuiteId = suiteId;
      }
    } catch {
      // Storage is a convenience here, never a precondition.
    } finally {
      await db.close();
    }
  }

  latest.set(input.variant, stored);
  history.unshift(stored);
  if (history.length > 20) history.length = 20;
  return stored;
}

export function clearRuns(): void {
  latest.clear();
  history.length = 0;
}
