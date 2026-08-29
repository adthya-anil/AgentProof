"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";

/**
 * Triggers a preflight run and streams it.
 *
 * A suite driven by a real model takes minutes, because every journey is a full
 * multi-turn tool-calling conversation. Two consequences shape this screen: the
 * run must be started deliberately, and it must be legible while it happens
 * rather than a spinner that eventually yields a table.
 */

type RunSize = "quick" | "standard" | "compare";
type Driver = "deterministic" | "agent";

interface ModelBreakdown {
  model: string;
  journeys: number;
  passed: number;
  unsafeViolations: number;
  inconclusive: number;
  firedInvariants: string[];
}

interface ScenarioRow {
  id: string;
  title: string;
  category: string;
  driver: Driver;
  /** Compact account of what happened, for the expanded row. */
  steps?: Array<{
    seq: number;
    type: string;
    tool?: string | null;
    reason?: string | null;
    decision?: string | null;
  }>;
  violations?: Array<{
    invariant: string;
    severity: string;
    message: string;
    remediation: string;
  }>;
  assignedModel?: string | null;
  model?: string | null;
  targetsInvariant?: string | null;
  state: "waiting" | "running" | "done";
  disposition?: string;
  note?: string;
  fired?: string[];
  defects?: number;
  moneyAtRisk?: number;
  providerOrders?: number;
  toolPath?: string[];
  durationMs?: number;
}

interface DoneSummary {
  runId: string;
  persistedSuiteId: string | null;
  readiness: string;
  passed: number;
  safelyRejected: number;
  escalated: number;
  unsafeViolations: number;
  inconclusive: number;
  agentDriven: number;
  byModel: ModelBreakdown[];
  errored: number;
  escapes: number;
  moneyAtRisk: number;
  durationMs: number;
}

export default function PreflightConsole({
  initialVariant,
}: {
  initialVariant: "vulnerable" | "fixed";
}) {
  const [variant, setVariant] = useState(initialVariant);
  const [size, setSize] = useState<RunSize>("quick");
  /**
   * Simulated by default.
   *
   * A suite is dozens of journeys, and a real Razorpay order per checkout is a lot
   * of live side effects to create by pressing one button. The important part is
   * not the default but that the report says which one actually ran.
   */

  /** Which journey row is expanded, if any. */
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const [meta, setMeta] = useState<{
    model: string;
    modelIsReal: boolean;
    pool: string[];
    /** Set when a model was given the adversary role instead of shopping. */
    adversaryModel: string | null;
    buyerModels: string[];
    paymentAdapter: string;
  } | null>(null);
  const [composition, setComposition] = useState<{
    total: number;
    agentDriven: number;
  } | null>(null);
  const [rows, setRows] = useState<ScenarioRow[]>([]);
  const [summary, setSummary] = useState<DoneSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => () => sourceRef.current?.close(), []);

  const start = useCallback(() => {
    sourceRef.current?.close();
    setRows([]);
    setSummary(null);
    setError(null);
    setMeta(null);
    setComposition(null);
    setPhase("Connecting");
    setRunning(true);

    const params = new URLSearchParams({
      variant,
      size,
    });
    const source = new EventSource(`/api/preflight?${params.toString()}`);
    sourceRef.current = source;

    source.onmessage = (message) => {
      const e = JSON.parse(message.data) as Record<string, unknown>;
      const kind = e.kind as string;

      if (kind === "start") {
        setMeta({
          model: e.model as string,
          modelIsReal: e.modelIsReal as boolean,
          pool: (e.pool as string[]) ?? [],
          adversaryModel: (e.adversaryModel as string | null) ?? null,
          buyerModels: (e.buyerModels as string[]) ?? [],
          paymentAdapter: e.paymentAdapter as string,
        });
      } else if (kind === "phase") {
        setPhase(e.note as string);
      } else if (kind === "assembled") {
        setPhase(`Running ${e.total} journeys`);
        setComposition({
          total: e.total as number,
          agentDriven: e.agentDriven as number,
        });
        setRows(
          (e.scenarios as Array<Omit<ScenarioRow, "state">>).map((s) => ({
            ...s,
            state: "waiting" as const,
          })),
        );
      } else if (kind === "scenario_start") {
        const id = e.id as string;
        setPhase(`Journey ${(e.index as number) + 1} of ${e.total}: ${id}`);
        setRows((prev) =>
          prev.map((r) => (r.id === id ? { ...r, state: "running" } : r)),
        );
      } else if (kind === "journey") {
        const id = e.id as string;
        setRows((prev) =>
          prev.map((r) =>
            r.id === id
              ? {
                  ...r,
                  state: "done",
                  model: e.model as string | null,
                  disposition: e.disposition as string,
                  note: e.note as string,
                  fired: e.fired as string[],
                  defects: e.defects as number,
                  moneyAtRisk: e.moneyAtRisk as number,
                  providerOrders: e.providerOrders as number,
                  toolPath: e.toolPath as string[],
                  durationMs: e.durationMs as number,
                  steps: e.steps as ScenarioRow["steps"],
                  violations: e.violations as ScenarioRow["violations"],
                }
              : r,
          ),
        );
      } else if (kind === "done") {
        setSummary(e as unknown as DoneSummary);
        setPhase(null);
        setRunning(false);
        source.close();
      } else if (kind === "error") {
        setError(e.message as string);
        setRunning(false);
        source.close();
      }
    };

    source.addEventListener("end", () => {
      setRunning(false);
      source.close();
    });
    source.onerror = () => {
      setRunning(false);
      source.close();
    };
  }, [variant, size]);

  const stop = useCallback(() => {
    sourceRef.current?.close();
    setRunning(false);
    setPhase(null);
  }, []);

  const doneCount = rows.filter((r) => r.state === "done").length;

  return (
    <>
      <div className="panel">
        <h2>Start a preflight run</h2>
        <p className="note" style={{ marginTop: 0 }}>
          Executes every scenario against the chosen integration. Live-agent
          journeys are full multi-turn tool-calling conversations with a real
          model, so a run takes minutes and costs tokens — which is why it only
          happens when you ask for it.
        </p>

        <div className="controls">
          <div className="switcher" style={{ marginBottom: 0 }}>
            <button
              type="button"
              onClick={() => setVariant("vulnerable")}
              data-active={String(variant === "vulnerable")}
              disabled={running}
            >
              Vulnerable
            </button>
            <button
              type="button"
              onClick={() => setVariant("fixed")}
              data-active={String(variant === "fixed")}
              disabled={running}
            >
              Fixed
            </button>
          </div>

          <label className="check">
            Run
            <select
              value={size}
              onChange={(e) => setSize(e.target.value as RunSize)}
              disabled={running}
            >
              <option value="quick">Quick — 15 journeys, seconds</option>
              <option value="standard">Standard — 30 journeys, a few minutes</option>
              <option value="compare">Compare models — 45 journeys</option>
            </select>
          </label>

          {running ? (
            <button type="button" className="primary" onClick={stop}>
              Stop
            </button>
          ) : (
            <button type="button" className="primary" onClick={start}>
              Run preflight
            </button>
          )}
        </div>

        {meta && (
          <div className="meta" style={{ marginTop: "1rem" }}>
            <div>
              <span>
                {meta.pool.length > 1 ? "Models" : "Model"}
              </span>
              {meta.pool.length > 0 ? meta.pool.join(" · ") : meta.model}
              {meta.modelIsReal ? "" : " (scripted)"}
            </div>
            <div>
              <span>Payments</span>
              {meta.paymentAdapter}
            </div>
            <div>
              <span>Integration</span>
              {variant}
            </div>
            {meta.adversaryModel && (
              <div>
                <span>Adversary</span>
                <span className="mono">{meta.adversaryModel}</span>
              </div>
            )}
            {composition && (
              <div>
                <span>Composition</span>
                {composition.agentDriven} live-agent ·{" "}
                {composition.total - composition.agentDriven} fixed
              </div>
            )}
          </div>
        )}

        {phase && (
          <p className="note" style={{ marginTop: "0.9rem", marginBottom: 0 }}>
            <span className="pulse">●</span> {phase}
            {rows.length > 0 && ` · ${doneCount}/${rows.length} complete`}
          </p>
        )}
      </div>

      {error && (
        <div className="panel">
          <h2>Run failed</h2>
          <p style={{ color: "var(--bad)", margin: 0 }}>{error}</p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="panel">
          <h2>
            Journeys ({doneCount}/{rows.length})
          </h2>
          <table>
            <thead>
              <tr>
                <th style={{ width: "2rem" }} />
                <th>Scenario</th>
                <th>Driven by</th>
                <th>Outcome</th>
                <th>Invariants fired</th>
                <th className="num">At risk</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <Fragment key={row.id}>
                <tr
                  style={{
                    opacity: row.state === "waiting" ? 0.45 : 1,
                    cursor: row.state === "done" ? "pointer" : "default",
                  }}
                  onClick={() =>
                    row.state === "done" &&
                    setOpenRow(openRow === row.id ? null : row.id)
                  }
                >
                  <td>
                    {row.state === "waiting" && <span className="note">·</span>}
                    {row.state === "running" && <span className="pulse">●</span>}
                    {row.state === "done" && (
                      <span
                        style={{
                          color:
                            row.disposition === "unsafe_violation"
                              ? "var(--bad)"
                              : row.disposition === "passed"
                                ? "var(--ok)"
                                : "var(--muted)",
                        }}
                      >
                        {row.disposition === "unsafe_violation"
                          ? "✗"
                          : row.disposition === "passed"
                            ? "✓"
                            : "•"}
                      </span>
                    )}
                  </td>
                  <td>
                    <code>{row.id}</code>
                    <div className="note">{row.title}</div>
                    {row.toolPath && row.toolPath.length > 0 && (
                      <div className="note mono" style={{ fontSize: "0.72rem" }}>
                        {row.toolPath.join(" → ")}
                      </div>
                    )}
                  </td>
                  <td>
                    <span
                      className={`driver ${row.driver === "agent" ? "live" : "fixed"}`}
                    >
                      {row.driver === "agent" ? "live agent" : "fixed repro"}
                    </span>
                    {(row.model ?? row.assignedModel) && (
                      <div className="note mono" style={{ fontSize: "0.7rem" }}>
                        {row.model ?? row.assignedModel}
                      </div>
                    )}
                    {row.targetsInvariant && (
                      <div className="note mono" style={{ fontSize: "0.7rem" }}>
                        {row.targetsInvariant}
                      </div>
                    )}
                  </td>
                  <td>
                    {row.disposition ? (
                      <span className={`badge ${row.disposition}`}>
                        {row.disposition.replace(/_/g, " ")}
                      </span>
                    ) : (
                      <span className="note">
                        {row.state === "running" ? "running…" : "queued"}
                      </span>
                    )}
                    {row.note && <div className="note">{row.note.slice(0, 90)}</div>}
                  </td>
                  <td className="mono note">
                    {row.fired && row.fired.length > 0 ? row.fired.join(", ") : "—"}
                  </td>
                  <td className="num note">
                    {row.moneyAtRisk ? `₹${row.moneyAtRisk}` : "—"}
                  </td>
                </tr>

                {/*
                  What happened, in place.
                  A row used to say a journey was an unsafe violation and leave you to
                  navigate elsewhere to find out why. The account of a finding belongs
                  next to the finding.
                */}
                {openRow === row.id && (
                  <tr>
                    <td colSpan={6} style={{ background: "var(--panel-2)" }}>
                      {row.violations && row.violations.length > 0 && (
                        <div style={{ marginBottom: "0.85rem" }}>
                          {row.violations.map((v) => (
                            <div key={v.invariant + v.message} className="finding">
                              <div>
                                <span className={`badge ${v.severity}`}>
                                  {v.severity}
                                </span>{" "}
                                <code>{v.invariant}</code>
                              </div>
                              <div>{v.message}</div>
                              <div className="note">Fix: {v.remediation}</div>
                            </div>
                          ))}
                        </div>
                      )}

                      <ol className="steps">
                        {(row.steps ?? []).map((step) => (
                          <li key={step.seq} data-decision={step.decision ?? ""}>
                            <span className="mono note">
                              {String(step.seq).padStart(2, "0")}
                            </span>{" "}
                            <span className="mono">{step.type}</span>
                            {step.tool ? (
                              <>
                                {" · "}
                                <code>{step.tool}</code>
                              </>
                            ) : null}
                            {step.reason ? (
                              <div className="note">{step.reason}</div>
                            ) : null}
                          </li>
                        ))}
                      </ol>

                      <p className="note" style={{ marginBottom: 0 }}>
                        {row.durationMs}ms ·{" "}
                        <Link
                          href={`/journey/${encodeURIComponent(row.id)}?integration=${variant}`}
                        >
                          full replay with payloads →
                        </Link>
                      </p>
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {summary && (
        <div className="panel">
          <h2>Result</h2>
          <div
            className={`readiness ${
              summary.readiness === "READY FOR CONTROLLED TEST"
                ? "ready"
                : summary.readiness === "INCONCLUSIVE"
                  ? "inconclusive"
                  : "notready"
            }`}
          >
            <span>
              {summary.readiness === "READY FOR CONTROLLED TEST"
                ? "✓"
                : summary.readiness === "INCONCLUSIVE"
                  ? "?"
                  : "✗"}
            </span>
            <div>
              {summary.readiness}
              <small>
                {summary.unsafeViolations} unsafe violation
                {summary.unsafeViolations === 1 ? "" : "s"} ·{" "}
                {summary.escapes} money-critical escape
                {summary.escapes === 1 ? "" : "s"} · completed in{" "}
                {(summary.durationMs / 1000).toFixed(0)}s
              </small>
            </div>
          </div>

          <div className="stats" style={{ marginTop: "1rem" }}>
            <div className="stat ok">
              <div className="n">{summary.passed}</div>
              <div className="k">Passed</div>
            </div>
            <div className="stat">
              <div className="n">{summary.safelyRejected}</div>
              <div className="k">Safely rejected</div>
            </div>
            <div className="stat warn">
              <div className="n">{summary.escalated}</div>
              <div className="k">Escalated</div>
            </div>
            <div className="stat bad">
              <div className="n">{summary.unsafeViolations}</div>
              <div className="k">Unsafe violations</div>
            </div>
            <div className="stat bad">
              <div className="n">{summary.escapes}</div>
              <div className="k">Escapes</div>
            </div>
            <div className="stat info">
              <div className="n">₹{summary.moneyAtRisk}</div>
              <div className="k">At risk, prevented</div>
            </div>
          </div>

          {summary.byModel.length > 1 && (
            <>
              <h2 style={{ marginTop: "1.5rem" }}>
                {meta?.adversaryModel ? "What each model did" : "Where the models differ"}
              </h2>
              {/*
                Conditional, because the unconditional version was false.
                With roles split — the default — each goal goes to exactly one model
                and the adversary drives only what it generated. The old text claimed
                every goal was attempted by every model and invited the reader to read
                disagreement as signal, on two rows covering disjoint scenario sets.
                In this run that read as "the adversary had 0 unsafe violations", which
                is true, meaningless, and flattering to the wrong thing.
              */}
              <p className="note" style={{ marginTop: 0 }}>
                {meta?.adversaryModel ? (
                  <>
                    <span className="mono">{meta?.adversaryModel}</span> was given the
                    adversary role and wrote the goals, so it only drove the journeys
                    it invented; every other live goal went to the buyer. The models
                    did different jobs on different scenarios, so this is a breakdown
                    by role — <strong>not</strong> a comparison. A row with fewer
                    unsafe violations is not a safer agent, it is a smaller and
                    different set of journeys. Use the Compare preset to send every
                    model at the same goals.
                  </>
                ) : (
                  <>
                    Every live goal was attempted by each model. Rows that disagree are
                    the interesting ones: they show how much the integration is relying
                    on the agent&apos;s own judgement rather than on its own checks.
                  </>
                )}
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th className="num">Journeys</th>
                    <th className="num">Passed</th>
                    <th className="num">Unsafe</th>
                    <th className="num">Inconclusive</th>
                    <th>Invariants tripped</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.byModel.map((entry) => (
                    <tr key={entry.model}>
                      <td className="mono">{entry.model}</td>
                      <td className="num">{entry.journeys}</td>
                      <td className="num">{entry.passed}</td>
                      <td
                        className="num"
                        style={{
                          color:
                            entry.unsafeViolations > 0 ? "var(--bad)" : undefined,
                        }}
                      >
                        {entry.unsafeViolations}
                      </td>
                      <td className="num note">{entry.inconclusive}</td>
                      <td className="mono note" style={{ fontSize: "0.72rem" }}>
                        {entry.firedInvariants.length > 0
                          ? entry.firedInvariants.join(", ")
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {summary.inconclusive > 0 && (
            <p className="note" style={{ marginTop: "1rem", marginBottom: 0 }}>
              {summary.inconclusive} of {summary.agentDriven} live-agent journey
              {summary.inconclusive === 1 ? "" : "s"} ended{" "}
              <strong>inconclusive</strong> — the agent ran out of tool budget or
              the model failed before anything decided the outcome. Those journeys
              verified nothing and are excluded from coverage rather than counted
              as safe.
            </p>
          )}

          <p className="note" style={{ marginTop: "1rem", marginBottom: 0 }}>
            Stored{summary.persistedSuiteId ? " and persisted to Postgres" : " in memory"}.{" "}
            <Link href={`/?integration=${variant}`}>Open the full report →</Link>{" "}
            <Link href={`/violations?integration=${variant}`}>Violations →</Link>{" "}
            <Link href={`/audit?integration=${variant}`}>Audit trail →</Link>
          </p>
        </div>
      )}
    </>
  );
}
