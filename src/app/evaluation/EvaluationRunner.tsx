"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Triggers the mutation evaluation and streams a row per mutant.
 *
 * Each defect is scored on its own, so this is eight sequential journeys. Fast
 * with the deterministic regression set, but still a run someone chose to start.
 */

interface Row {
  mutation: string;
  title?: string;
  expectedInvariant?: string;
  detectedBy?: string[];
  detected?: boolean;
  state: "running" | "done";
}

export default function EvaluationRunner() {
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => () => sourceRef.current?.close(), []);

  const start = useCallback(() => {
    sourceRef.current?.close();
    setRows([]);
    setError(null);
    setFinished(false);
    setRunning(true);

    const source = new EventSource("/api/evaluation");
    sourceRef.current = source;

    source.onmessage = (message) => {
      const e = JSON.parse(message.data) as Record<string, unknown>;
      const kind = e.kind as string;

      if (kind === "mutation_start") {
        const mutation = e.mutation as string;
        setRows((prev) => [...prev, { mutation, state: "running" }]);
      } else if (kind === "mutation_scored") {
        setRows((prev) =>
          prev.map((r) =>
            r.mutation === (e.mutation as string)
              ? {
                  ...r,
                  state: "done",
                  title: e.title as string,
                  expectedInvariant: e.expectedInvariant as string,
                  detectedBy: e.detectedBy as string[],
                  detected: e.detected as boolean,
                }
              : r,
          ),
        );
      } else if (kind === "done") {
        setRunning(false);
        setFinished(true);
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
  }, []);

  return (
    <>
      <button
        type="button"
        className="primary"
        onClick={start}
        disabled={running}
      >
        {running ? "Scoring…" : "Run the mutation evaluation"}
      </button>

      {error && (
        <p style={{ color: "var(--bad)", marginBottom: 0 }}>{error}</p>
      )}

      {rows.length > 0 && (
        <table style={{ marginTop: "1rem" }}>
          <thead>
            <tr>
              <th style={{ width: "2rem" }} />
              <th>Mutation</th>
              <th>Expected invariant</th>
              <th>Fired</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.mutation}>
                <td>
                  {row.state === "running" ? (
                    <span className="pulse">●</span>
                  ) : (
                    <span
                      style={{ color: row.detected ? "var(--ok)" : "var(--bad)" }}
                    >
                      {row.detected ? "✓" : "✗"}
                    </span>
                  )}
                </td>
                <td>
                  <code>{row.mutation}</code>
                  {row.title && <div className="note">{row.title}</div>}
                </td>
                <td className="mono note">{row.expectedInvariant ?? "—"}</td>
                <td className="mono note">
                  {row.detectedBy && row.detectedBy.length > 0
                    ? row.detectedBy.join(", ")
                    : row.state === "done"
                      ? "—"
                      : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {finished && (
        <p className="note" style={{ marginBottom: 0 }}>
          Scored. <a href="/evaluation">Reload for the full metrics →</a>
        </p>
      )}
    </>
  );
}
