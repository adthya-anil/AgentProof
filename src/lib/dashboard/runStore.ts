import { randomUUID } from "node:crypto";
import { Db, migrate } from "../db/client.js";
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

export function getLatestRun(variant: IntegrationVariant): StoredRun | null {
  return latest.get(variant) ?? null;
}

export function getRunHistory(limit = 10): StoredRun[] {
  return history.slice(0, limit);
}

export function hasAnyRun(): boolean {
  return latest.size > 0;
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
