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
            <span>
              {engine.pool.length > 1
                ? `Agents (${engine.pool.length})`
                : "Agent"}
            </span>
            {engine.pool.length > 0 ? (
              <span className="mono">{engine.pool.join(" · ")}</span>
            ) : (
              <>
                {engine.model}
                {engine.modelIsReal ? "" : " — scripted"}
              </>
            )}
          </div>
          <div>
            <span>Razorpay</span>
            {/*
              Says only whether credentials exist, because that is all this panel
              can honestly know. Whether a run *uses* them is chosen per run, and
              is reported by the run itself. Printing the adapter name here made
              the page claim every journey hit Razorpay when none did.
            */}
            {engine.razorpayConfigured
              ? `test keys present (${engine.razorpayKeyId})`
              : "not configured"}
          </div>
          <div>
            <span>Policy</span>
            <code>{engine.policyVersion}</code>
          </div>
        </div>

        {engine.pool.length === 0 ? (
          <p className="note" style={{ marginTop: "0.85rem", marginBottom: 0 }}>
            No real model is configured, so a live-agent run will be refused
            rather than quietly replaced by a script. Set{" "}
            <code>LLM_ADAPTER=openai</code>, <code>LLM_API_KEY</code>,{" "}
            <code>LLM_MODEL</code> and <code>LLM_BASE_URL</code> in{" "}
            <code>.env</code>, then restart — <code>.env</code> is read once at
            startup.
          </p>
        ) : engine.pool.length === 1 ? (
          /**
           * Say why only one model is loaded, right where it is noticed.
           *
           * This panel showed the primary adapter and nothing else, so a second
           * model that had failed to load looked identical to one that was never
           * configured — and the singular "Model" label read as confirmation that
           * one was all there should be.
           */
          <p className="note" style={{ marginTop: "0.85rem", marginBottom: 0 }}>
            One agent will drive every live journey. To have a second model attempt
            the same goals — which is where the interesting disagreements show up —
            add <code>ANTHROPIC_MODEL</code> and <code>ANTHROPIC_BASE_URL</code> to{" "}
            <code>.env</code> and restart the server. The key falls back to{" "}
            <code>LLM_API_KEY</code>, so no second secret is needed.
          </p>
        ) : (
          <p className="note" style={{ marginTop: "0.85rem", marginBottom: 0 }}>
            Every live goal will be attempted by all {engine.pool.length} agents, so
            the report can attribute a finding to a specific model rather than to
            &ldquo;an AI&rdquo;.
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
