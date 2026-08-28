import type { BuyerIntent } from "../core/types.js";
import type { ToolCaller, ToolResult } from "../guard/guard.js";
import { TOOL_DECLARATIONS, TOOL_NAMES, type ToolName } from "../hamperhub/tools.js";
import {
  type ChatMessage,
  type LLM,
  type LlmToolDefinition,
  LlmError,
} from "./llm.js";

/**
 * The autonomous buyer agent.
 *
 * It is handed a buyer intent and the commerce tool declarations, then decides
 * its own sequence of tool calls, reacting to each result — exactly the
 * open-ended behaviour that fixed test scripts cannot capture. Every call goes
 * through the Guard, so the agent's autonomy never extends to moving money: it
 * can *request* a checkout, but the deterministic engine decides whether one
 * happens.
 *
 * The loop is provider-neutral. With the scripted LLM it is fully deterministic;
 * with a real model it is genuinely adaptive. The code path is identical, which
 * is what lets a demo rehearsed on the scripted model behave the same way when
 * pointed at a real one.
 */

export interface BuyerAgentOptions {
  llm: LLM;
  /** Usually the Guard; may be a perturbation wrapper around it. */
  guard: ToolCaller;
  /** Hard cap on tool calls, so a confused or looping model always terminates. */
  maxToolCalls?: number;
  /** Extra guidance appended to the system prompt (e.g. a scripted strategy). */
  systemSuffix?: string;
  /**
   * Abandon the journey when a tool call is blocked outright.
   *
   * Defaults to true because that is what a competent agent does, and because
   * continuing buries the real failure under follow-up errors caused by missing
   * ids. Set false to study how an agent behaves when it ignores a refusal.
   */
  stopOnHardFailure?: boolean;
}

export interface AgentTranscriptEntry {
  tool: ToolName;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
}

export interface AgentRunResult {
  /** True if the agent reached a confirmed order via get_payment_status/fulfil. */
  reachedCheckout: boolean;
  toolCalls: number;
  transcript: AgentTranscriptEntry[];
  /** Final assistant text, if the model chose to stop with prose. */
  finalMessage: string;
  model: string;
  /** Non-fatal note when the loop stopped for a reason other than completion. */
  stopReason: "completed" | "max_tool_calls" | "no_tool_call" | "llm_error";
  /**
   * The last tool result the Guard returned.
   *
   * The runner needs this to tell a merchant self-rejection from a Guard block.
   * Without it every agent-driven journey looks like the Guard caught something
   * the integration missed, which would blame correct integrations for defects
   * they do not have.
   */
  lastResult?: ToolResult;
}

const SYSTEM_PROMPT = `You are an autonomous shopping agent buying a gift on \
behalf of a human buyer from the HamperHub gift store.

Your job: fulfil the buyer's request by calling the available tools. Work \
step by step. Search for suitable products, assemble a bundle, get a quote, \
show it to the buyer for approval, then check out and confirm payment.

Rules you must follow:
- Only spend up to the buyer's stated budget.
- Respect any dietary or allergen constraints the buyer stated. If a product's \
allergen or vegan data is null, that means unknown — do not assume it is safe.
- Before checkout, you must have explicit buyer approval for the exact amount.
- Amounts are in rupees.

How approval works. You have no live channel to the buyer, so you record their \
consent with approve_quote: pass the exact quote total as approved_amount and \
quote the buyer's own authorising words as confirmation_text. Only do this when \
the buyer's request already authorised a purchase up to a limit and the quote is \
within it. If the buyer gave no such authorisation, stop after the quote and \
explain that you need their confirmation.

Then call create_checkout with the quote id and the approval receipt id, and \
finally get_payment_status to confirm the payment.

Call exactly one tool at a time and wait for its result before deciding the \
next step. When the order is confirmed, or if you cannot proceed, stop and \
briefly explain.`;

export class BuyerAgent {
  private readonly llm: LLM;
  private readonly guard: ToolCaller;
  private readonly maxToolCalls: number;
  private readonly systemSuffix: string;
  private readonly stopOnHardFailure: boolean;

  constructor(options: BuyerAgentOptions) {
    this.llm = options.llm;
    this.guard = options.guard;
    this.maxToolCalls = options.maxToolCalls ?? 12;
    this.systemSuffix = options.systemSuffix ?? "";
    this.stopOnHardFailure = options.stopOnHardFailure ?? true;
  }

  /**
   * A refusal there is no point working around.
   *
   * A provider timeout is explicitly *not* hard: retrying it is legitimate, and
   * that retry is exactly the behaviour the idempotency rule exists to contain.
   */
  private isHardFailure(result: Extract<ToolResult, { ok: false }>): boolean {
    if (result.decision === "invalid") return false;
    return !(result.decision === "rejected" && !result.blockedByGuard
      ? /retryable/i.test(result.reason)
      : false);
  }

  async run(intent: BuyerIntent): Promise<AgentRunResult> {
    const tools: LlmToolDefinition[] = TOOL_DECLARATIONS.map((decl) => ({
      name: decl.name,
      description: decl.description,
      parameters: decl.parameters,
    }));

    const messages: ChatMessage[] = [
      { role: "user", content: this.describeIntent(intent) },
    ];
    const transcript: AgentTranscriptEntry[] = [];
    let toolCalls = 0;
    let model = this.llm.name;
    let finalMessage = "";
    let lastResult: ToolResult | undefined;

    while (toolCalls < this.maxToolCalls) {
      let completion;
      try {
        completion = await this.llm.complete({
          system: SYSTEM_PROMPT + this.systemSuffix,
          messages,
          tools,
          temperature: 0,
        });
      } catch (error) {
        // A model failure is not a commerce outcome. Record it and stop; the
        // Guard has still evaluated everything that did happen.
        return {
          reachedCheckout: transcript.some((t) => t.tool === "get_payment_status" && t.ok),
          toolCalls,
          transcript,
          finalMessage:
            error instanceof LlmError ? `LLM error: ${error.message}` : String(error),
          model,
          stopReason: "llm_error",
          lastResult,
        };
      }
      model = completion.model;

      if (completion.toolCalls.length === 0) {
        finalMessage = completion.content;
        return {
          reachedCheckout: transcript.some(
            (t) => t.tool === "get_payment_status" && t.ok,
          ),
          toolCalls,
          transcript,
          finalMessage,
          model,
          stopReason: "no_tool_call",
          lastResult,
        };
      }

      // Record the assistant's tool request in the transcript for the model.
      messages.push({
        role: "assistant",
        content: completion.content,
        toolCalls: completion.toolCalls,
      });

      // Execute each requested call through the Guard, in order.
      for (const call of completion.toolCalls) {
        toolCalls += 1;
        const toolName = this.coerceToolName(call.name);

        let result: ToolResult;
        if (!toolName) {
          result = {
            ok: false,
            blockedByGuard: true,
            decision: "invalid",
            reason: `Unknown tool: ${call.name}`,
            violations: [],
            financialActionTaken: false,
          };
        } else {
          result = await this.guard.callTool(toolName, call.arguments);
        }

        lastResult = result;
        const summary = this.summarize(result);
        transcript.push({
          tool: (toolName ?? call.name) as ToolName,
          args: call.arguments,
          ok: result.ok,
          summary,
        });

        // Feed the result back so the model can adapt its next move.
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: JSON.stringify(this.toolPayload(result)),
        });

        // Stop on a hard block. A competent agent that is told "checkout blocked,
        // quote expired" does not then ask for the payment status of a payment
        // that was never created. Marching on would also bury the real failure
        // under a meaningless follow-up error.
        if (this.stopOnHardFailure && !result.ok && this.isHardFailure(result)) {
          return {
            reachedCheckout: transcript.some(
              (t) => t.tool === "get_payment_status" && t.ok,
            ),
            toolCalls,
            transcript,
            finalMessage: `Stopped: ${result.reason}`,
            model,
            stopReason: "no_tool_call",
            lastResult,
          };
        }

        if (toolCalls >= this.maxToolCalls) break;
      }
    }

    return {
      reachedCheckout: transcript.some(
        (t) => t.tool === "get_payment_status" && t.ok,
      ),
      toolCalls,
      transcript,
      finalMessage: finalMessage || "Reached the tool-call budget.",
      model,
      stopReason: "max_tool_calls",
      lastResult,
    };
  }

  private describeIntent(intent: BuyerIntent): string {
    const c = intent.constraints;
    const parts = [intent.utterance, "", "Structured constraints:"];
    if (c.maxBudgetMinor !== null) {
      parts.push(`- Maximum total budget: ₹${c.maxBudgetMinor / 100}`);
    }
    if (c.requireVegan) parts.push("- All items must be vegan.");
    if (c.mustAvoidAllergens.length > 0) {
      parts.push(`- Must avoid allergens: ${c.mustAvoidAllergens.join(", ")}.`);
    }
    if (c.occasion) parts.push(`- Occasion: ${c.occasion}.`);
    if (c.themes.length > 0) parts.push(`- Themes: ${c.themes.join(", ")}.`);
    return parts.join("\n");
  }

  private coerceToolName(name: string): ToolName | null {
    return TOOL_NAMES.includes(name as ToolName) ? (name as ToolName) : null;
  }

  /** What the model sees back. On failure it gets the reason so it can adapt. */
  private toolPayload(result: ToolResult): unknown {
    if (result.ok) return result.data;
    return {
      error: true,
      decision: result.decision,
      reason: result.reason,
      // Signal that a retry is pointless when the Guard blocked on policy.
      retryable: result.decision === "rejected" && !result.blockedByGuard,
    };
  }

  private summarize(result: ToolResult): string {
    if (result.ok) return "ok";
    const who = result.blockedByGuard ? "guard" : "merchant";
    return `${who}:${result.decision} — ${result.reason.slice(0, 120)}`;
  }
}
