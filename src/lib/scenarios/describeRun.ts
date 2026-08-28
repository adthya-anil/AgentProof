import type { AgentRunResult } from "../agent/buyer.js";
import type { ScenarioOutcome } from "./types.js";

/**
 * Turns an agent run into a scenario outcome.
 *
 * Shared by every agent-driven scenario family — regression replays, transport
 * perturbations, generated goals — because they had each grown their own copy and
 * the copies had drifted. Only one of them surfaced the model's error text, which
 * meant a failed journey elsewhere reported a bare `llm_error` and left nobody
 * able to say what had actually gone wrong.
 */
export function describeAgentRun(run: AgentRunResult): ScenarioOutcome {
  const last = run.transcript[run.transcript.length - 1];

  return {
    completed: run.reachedCheckout,
    note:
      `${run.transcript.length} tool calls; ${describeStop(run)}` +
      (last && !last.ok ? ` — last ${last.tool}: ${last.summary}` : ""),
    // Lets the runner tell a merchant self-rejection from a Guard block.
    lastResult: run.lastResult,
    model: run.model,
    // An exhausted budget or a provider failure decided nothing.
    inconclusive:
      !run.reachedCheckout &&
      (run.stopReason === "max_tool_calls" || run.stopReason === "llm_error"),
  };
}

/**
 * Says who ended the journey, in plain words.
 *
 * `no_tool_call` does double duty in the raw stop reason: it covers an agent that
 * stopped to ask the buyer for approval — a good outcome — and one that gave up
 * after being blocked. A reader should not have to infer which from a tool count.
 *
 * On `llm_error` the provider's own message is included. Without it a run reports
 * `llm_error` and nothing else, and a transient 429 is indistinguishable from a
 * malformed request that will fail every time.
 */
function describeStop(run: AgentRunResult): string {
  if (run.reachedCheckout) return "completed";

  if (run.stopReason === "llm_error") {
    return `llm_error — ${run.finalMessage.replace(/^LLM error:\s*/, "")}`;
  }

  if (run.stopReason === "no_tool_call") {
    return run.lastResult && !run.lastResult.ok
      ? "agent stopped after a block"
      : "agent declined to proceed";
  }

  return run.stopReason;
}
