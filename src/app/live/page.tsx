import { isRealLlmConfigured, llmPoolFromEnv } from "@/lib/agent/factory";
import { loadDotEnv } from "@/lib/core/env";
import { Tabs } from "../components";
import LiveConsole from "./LiveConsole";

export const dynamic = "force-dynamic";

/**
 * Watch it happen.
 *
 * A real model, given only the buyer's request and the tool schemas, decides its
 * own sequence — and the deterministic Guard rules on every step as it goes.
 * Nothing here is scripted, which is the whole point of the page.
 */
export default function LivePage() {
  loadDotEnv();
  const realModel = isRealLlmConfigured();
  const pool = llmPoolFromEnv().filter((llm) => llm.isReal);

  return (
    <>
      <Tabs active="live" variant="vulnerable" />

      <div className="panel">
        <h2>Live agent run</h2>
        <p className="note" style={{ marginTop: 0, marginBottom: 0 }}>
          An autonomous agent is given the buyer&apos;s request and the six
          commerce tools — nothing else. It chooses what to call and in what
          order. Every line that appears below is an entry being written to the
          tamper-evident audit log, streamed as it happens, and the Guard&apos;s
          verdict on each step is computed by the same deterministic invariants
          that run in production.
        </p>
      </div>

      {!realModel && (
        <div className="panel">
          <h2>No model configured</h2>
          <p className="note" style={{ marginTop: 0, marginBottom: 0 }}>
            The agent will follow a fixed script, so this page will show a
            reproducible journey rather than a genuinely autonomous one. Set{" "}
            <code>LLM_ADAPTER=openai</code>, <code>LLM_API_KEY</code>,{" "}
            <code>LLM_MODEL</code> and <code>LLM_BASE_URL</code> in{" "}
            <code>.env</code> to let a real model decide.
          </p>
        </div>
      )}

      {pool.length > 1 && (
        <div className="panel">
          <h2>Two agents, same store</h2>
          <p className="note" style={{ marginTop: 0, marginBottom: 0 }}>
            {pool.map((llm) => llm.name).join(" and ")} are both configured. Run
            the identical buyer request through each and compare — they do not
            shop the same way, and the differences are exactly what a merchant
            cannot control.
          </p>
        </div>
      )}

      <LiveConsole models={pool.map((llm) => llm.name)} />
    </>
  );
}
