import Link from "next/link";
import { loadDotEnv } from "@/lib/core/env";
import { describeEngine } from "@/lib/dashboard/data";
import { getRunHistory } from "@/lib/dashboard/runStore";
import { Tabs } from "../components";
import PreflightConsole from "./PreflightConsole";

export const dynamic = "force-dynamic";

function parseVariant(value: string | undefined): "vulnerable" | "fixed" {
  return value === "fixed" ? "fixed" : "vulnerable";
}

/**
 * Where a preflight run is started.
 *
 * Runs are explicit. Report pages read a stored result and never execute one
 * themselves: with a real model a suite costs minutes and real tokens, and
 * spending either because someone opened a page is indefensible.
 */
export default async function PreflightPage({
  searchParams,
}: {
  searchParams: Promise<{ variant?: string; integration?: string }>;
}) {
  loadDotEnv();
  const params = await searchParams;
  // Accept either name: the rest of the dashboard links with `integration`.
  const variant = parseVariant(params.variant ?? params.integration);
  const engine = describeEngine();
  const history = getRunHistory(8);

  return (
    <>
      <Tabs active="preflight" variant={variant} />

      <div className="panel">
        <h2>Engine</h2>
        <div className="meta">
          <div>
            <span>Model</span>
            {engine.model}
            {engine.modelIsReal ? "" : " — scripted"}
          </div>
          <div>
            <span>Payments</span>
            {engine.paymentAdapter}
          </div>
          <div>
            <span>Policy</span>
            <code>{engine.policyVersion}</code>
          </div>
        </div>
        {!engine.modelIsReal && (
          <p className="note" style={{ marginTop: "0.85rem", marginBottom: 0 }}>
            No real model is configured, so journeys will follow a fixed script.
            Set <code>LLM_ADAPTER=openai</code>, <code>LLM_API_KEY</code>,{" "}
            <code>LLM_MODEL</code> and <code>LLM_BASE_URL</code> in{" "}
            <code>.env</code> to let a model choose its own tool sequence.
          </p>
        )}
      </div>

      <PreflightConsole initialVariant={variant} />

      {history.length > 0 && (
        <div className="panel">
          <h2>Recent runs</h2>
          <table>
            <thead>
              <tr>
                <th>Finished</th>
                <th>Integration</th>
                <th>Model</th>
                <th className="num">Journeys</th>
                <th className="num">Unsafe</th>
                <th>Readiness</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {history.map((run) => (
                <tr key={run.id}>
                  <td className="note">
                    {new Date(run.finishedAt).toLocaleTimeString()}
                  </td>
                  <td>{run.variant}</td>
                  <td className="note">{run.model}</td>
                  <td className="num">{run.suite.journeys.length}</td>
                  <td className="num">{run.suite.unsafeViolations}</td>
                  <td>
                    <span
                      className={`badge ${
                        run.suite.readiness === "READY FOR CONTROLLED TEST"
                          ? "passed"
                          : "unsafe_violation"
                      }`}
                    >
                      {run.suite.readiness}
                    </span>
                  </td>
                  <td>
                    <Link href={`/?integration=${run.variant}`}>report →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
