import type { Db } from "./client.js";

/**
 * Read queries for persisted runs.
 *
 * These exist so a reviewer can open a run recorded yesterday. Returned shapes
 * are deliberately flat and JSON-friendly rather than rehydrated domain objects:
 * the engine never reads its own history back, so there is nothing to gain from
 * reconstructing live objects, and a flat row is easier to render.
 */

export interface SuiteSummaryRow {
  id: string;
  label: string;
  integration_variant: string;
  policy_version: string | null;
  mutations: string[];
  passed: number;
  safely_rejected: number;
  inconclusive: number;
  escalated: number;
  unsafe_violations: number;
  errored: number;
  money_critical_escapes: number;
  money_at_risk_minor: string;
  readiness: string;
  audit_chain_ok: boolean;
  duration_ms: number;
  metrics: Record<string, unknown>;
  created_at: Date;
  journeys: number;
}

export async function listSuites(
  db: Db,
  limit = 20,
): Promise<SuiteSummaryRow[]> {
  return db.query<SuiteSummaryRow>(
    `select s.*, (select count(*) from test_runs r where r.suite_id = s.id)::int as journeys
       from suites s
      order by s.created_at desc
      limit $1`,
    [limit],
  );
}

export interface TestRunRow {
  id: string;
  scenario_id: string;
  title: string;
  category: string;
  driver: string;
  model: string | null;
  disposition: string;
  note: string;
  fired_invariants: string[];
  money_at_risk_minor: string;
  provider_orders: number;
  duplicate_payable_orders: number;
  self_rejected: boolean;
  audit_events: number;
  audit_chain_ok: boolean;
  duration_ms: number;
  ms_to_first_violation: number | null;
  error: string | null;
}

export async function listTestRuns(
  db: Db,
  suiteId: string,
): Promise<TestRunRow[]> {
  return db.query<TestRunRow>(
    `select id, scenario_id, title, category, driver, model, disposition, note,
            fired_invariants, money_at_risk_minor, provider_orders,
            duplicate_payable_orders, self_rejected, audit_events,
            audit_chain_ok, duration_ms, ms_to_first_violation, error
       from test_runs where suite_id = $1 order by created_at, scenario_id`,
    [suiteId],
  );
}

export interface ModelBreakdownRow {
  model: string;
  journeys: number;
  passed: number;
  unsafe_violations: number;
  inconclusive: number;
}

/**
 * Per-model outcomes for a stored suite.
 *
 * The aggregate columns on `suites` cannot answer this, and averaging two models
 * together hides the only thing worth knowing when you run more than one: which
 * of them walked into the defect.
 */
export async function modelBreakdown(
  db: Db,
  suiteId: string,
): Promise<ModelBreakdownRow[]> {
  return db.query<ModelBreakdownRow>(
    `select model,
            count(*)::int as journeys,
            count(*) filter (where disposition = 'passed')::int as passed,
            count(*) filter (where disposition = 'unsafe_violation')::int
              as unsafe_violations,
            count(*) filter (where disposition = 'inconclusive')::int
              as inconclusive
       from test_runs
      where suite_id = $1 and model is not null
      group by model
      order by model`,
    [suiteId],
  );
}

export interface AuditEventRow {
  seq: number;
  occurred_at: Date;
  type: string;
  tool_name: string | null;
  decision: string | null;
  reason: string | null;
  output: Record<string, unknown> | null;
  provider_order_id: string | null;
  prev_hash: string;
  hash: string;
}

export async function listAuditEvents(
  db: Db,
  testRunId: string,
): Promise<AuditEventRow[]> {
  return db.query<AuditEventRow>(
    `select seq, occurred_at, type, tool_name, decision, reason, output,
            provider_order_id, prev_hash, hash
       from audit_events where test_run_id = $1 order by seq`,
    [testRunId],
  );
}

export interface ViolationRow {
  id: string;
  invariant_id: string;
  title: string;
  severity: string;
  attribution: string;
  kind: string;
  checkpoint: string;
  message: string;
  money_at_risk_minor: string;
  remediation: string | null;
}

export async function listViolations(
  db: Db,
  testRunId: string,
): Promise<ViolationRow[]> {
  return db.query<ViolationRow>(
    `select id, invariant_id, title, severity, attribution, kind, checkpoint,
            message, money_at_risk_minor, remediation
       from violations where test_run_id = $1 order by severity, invariant_id`,
    [testRunId],
  );
}

export interface ToolExecutionRow {
  seq: number;
  tool_name: string;
  ok: boolean;
  summary: string;
  arguments: Record<string, unknown>;
}

export async function listToolExecutions(
  db: Db,
  testRunId: string,
): Promise<ToolExecutionRow[]> {
  return db.query<ToolExecutionRow>(
    `select seq, tool_name, ok, summary, arguments
       from tool_executions where test_run_id = $1 order by seq`,
    [testRunId],
  );
}

/**
 * Recomputes the stored hash chain per run.
 *
 * The chain is verified in memory when a run executes, but that proves nothing
 * about what reached the database. This checks the persisted rows link correctly,
 * which is the claim that matters once the process is gone.
 */
export async function verifyStoredChains(
  db: Db,
): Promise<Array<{ testRunId: string; ok: boolean; brokenAtSeq: number | null }>> {
  const runs = await db.query<{ id: string }>(`select id from test_runs`);
  const results: Array<{
    testRunId: string;
    ok: boolean;
    brokenAtSeq: number | null;
  }> = [];

  for (const run of runs) {
    const events = await db.query<{
      seq: number;
      prev_hash: string;
      hash: string;
    }>(
      `select seq, prev_hash, hash from audit_events
        where test_run_id = $1 order by seq`,
      [run.id],
    );

    let ok = true;
    let brokenAtSeq: number | null = null;
    let previous = "0".repeat(64);
    for (const event of events) {
      if (event.prev_hash !== previous) {
        ok = false;
        brokenAtSeq = event.seq;
        break;
      }
      previous = event.hash;
    }
    results.push({ testRunId: run.id, ok, brokenAtSeq });
  }
  return results;
}

export interface DbCounts {
  table: string;
  rows: number;
}

export async function tableCounts(db: Db): Promise<DbCounts[]> {
  const tables = [
    "merchants",
    "policies",
    "policy_rules",
    "commerce_tools",
    "products",
    "inventory_records",
    "test_scenarios",
    "suites",
    "test_runs",
    "tool_executions",
    "violations",
    "audit_events",
  ];
  const counts: DbCounts[] = [];
  for (const table of tables) {
    const rows = await db.query<{ n: string }>(
      `select count(*)::text as n from ${table}`,
    );
    counts.push({ table, rows: Number(rows[0]?.n ?? 0) });
  }
  return counts;
}


export interface StoredSuiteSnapshot {
  id: string;
  label: string;
  integration_variant: string;
  generator_model: string | null;
  generator_is_real: boolean;
  adversary_model: string | null;
  payment_adapter: string | null;
  created_at: Date;
  duration_ms: number;
  /** Exact SuiteResult as produced, for faithful replay. */
  result: unknown;
}

/**
 * The most recent stored run for an integration variant.
 *
 * This is what lets a run outlive the process that produced it. Until now the
 * dashboard read an in-memory cache, so restarting the server showed "no run yet"
 * while the rows sat in Postgres — the one place the product delivered less than it
 * claimed.
 *
 * Returns the snapshot rather than reassembling from the normalised tables, because
 * those omit eight replay-only fields and a reconstruction would render a report
 * subtly poorer than the one produced, with no way for a reader to tell which gaps
 * were real.
 */
export async function latestSuiteFor(
  db: Db,
  variant: string,
): Promise<StoredSuiteSnapshot | null> {
  const rows = await db.query<StoredSuiteSnapshot>(
    `select id, label, integration_variant, generator_model, generator_is_real,
            adversary_model, payment_adapter, created_at, duration_ms, result
       from suites
      where integration_variant = $1 and result is not null
      order by created_at desc
      limit 1`,
    [variant],
  );
  return rows[0] ?? null;
}

/** Recent stored runs across both variants, newest first. */
export async function recentSuiteSnapshots(
  db: Db,
  limit = 10,
): Promise<StoredSuiteSnapshot[]> {
  return db.query<StoredSuiteSnapshot>(
    `select id, label, integration_variant, generator_model, generator_is_real,
            adversary_model, payment_adapter, created_at, duration_ms, result
       from suites
      where result is not null
      order by created_at desc
      limit $1`,
    [limit],
  );
}
