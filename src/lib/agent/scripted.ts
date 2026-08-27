import {
  type CompletionRequest,
  type CompletionResult,
  type LLM,
  type LlmToolCall,
} from "./llm.js";

/**
 * A deterministic stand-in for a tool-calling model.
 *
 * This is not a mock that returns canned strings. It is a small state machine
 * that reads the same tool schemas and conversation a real model would, and
 * plays a plausible buyer strategy end to end: search, bundle, quote, approve,
 * checkout, verify. Crucially it reproduces the *risky* moves a real agent makes
 * — applying every discount it can, treating a filtered search result as safe,
 * retrying after a timeout — so preflight exercises those paths without a key
 * and without flakiness.
 *
 * A "strategy" is just an ordered plan of tool calls with placeholders that get
 * resolved from earlier tool responses (a bundle id, a quote id, and so on).
 * The generator (see scenarios) picks a strategy per journey; here we execute
 * whichever one the buyer intent implies.
 */

export interface ScriptedStep {
  tool: string;
  /**
   * Arguments, where any string value of the form "$ref:key" is resolved from
   * the running context captured out of prior tool responses.
   */
  args: Record<string, unknown>;
}

export interface ScriptedStrategy {
  /** Human-readable label, surfaced in traces. */
  label: string;
  steps: ScriptedStep[];
}

const CONTROL_KEY = "__agentproof_strategy";

/**
 * Encodes a strategy into the buyer intent utterance channel.
 *
 * The buyer agent passes the whole conversation to the LLM; for the scripted
 * LLM we smuggle the plan through a fenced control block on the system prompt so
 * that the scripted model is self-contained and the agent code path is byte-for
 * byte identical whether the LLM is scripted or real.
 */
export function encodeStrategy(strategy: ScriptedStrategy): string {
  return `\n\n<<<${CONTROL_KEY}:${Buffer.from(
    JSON.stringify(strategy),
  ).toString("base64")}>>>`;
}

function decodeStrategy(system: string): ScriptedStrategy | null {
  const match = system.match(
    new RegExp(`<<<${CONTROL_KEY}:([A-Za-z0-9+/=]+)>>>`),
  );
  if (!match) return null;
  try {
    return JSON.parse(Buffer.from(match[1]!, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export class ScriptedLLM implements LLM {
  readonly name = "scripted";
  readonly isReal = false;

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    // JSON-mode requests come from the scenario generator, not the agent loop.
    if (request.responseFormat === "json") {
      return {
        content: this.scriptedGeneratorOutput(request),
        toolCalls: [],
        model: this.name,
      };
    }

    const strategy = decodeStrategy(request.system);
    if (!strategy) {
      return { content: "Understood.", toolCalls: [], model: this.name };
    }

    // Count how many tool calls the agent has already issued by looking at the
    // assistant tool-call messages in the transcript, then play the next step.
    const issued = request.messages.filter(
      (m) => m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0,
    ).length;

    if (issued >= strategy.steps.length) {
      return {
        content: `Done: ${strategy.label}.`,
        toolCalls: [],
        model: this.name,
      };
    }

    const step = strategy.steps[issued]!;
    const context = this.buildContext(request);
    const args = this.resolveArgs(step.args, context);

    const call: LlmToolCall = {
      id: `call_${issued + 1}`,
      name: step.tool,
      arguments: args,
    };
    return {
      content: "",
      toolCalls: [call],
      model: this.name,
    };
  }

  /**
   * Reconstructs a small key→value context from prior tool responses so that a
   * step can reference, e.g., "$ref:bundle_id" or "$ref:total".
   */
  private buildContext(request: CompletionRequest): Record<string, unknown> {
    const ctx: Record<string, unknown> = {};
    for (const message of request.messages) {
      if (message.role !== "tool" || !message.content) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(message.content);
      } catch {
        continue;
      }
      collect(payload, ctx);
    }
    return ctx;
  }

  private resolveArgs(
    args: Record<string, unknown>,
    context: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      out[key] = resolveValue(value, context);
    }
    return out;
  }

  /**
   * The scripted scenario generator.
   *
   * Returns a fixed but varied set of buyer goals so a keyless preflight still
   * demonstrates semantic and adversarial coverage. The real generator (OpenAI)
   * produces these dynamically; the shape is identical so the runner does not
   * care which produced them.
   */
  private scriptedGeneratorOutput(_request: CompletionRequest): string {
    return JSON.stringify({ scenarios: [] });
  }
}

function collect(payload: unknown, ctx: Record<string, unknown>): void {
  if (Array.isArray(payload)) {
    // Remember the first product id from a search so "pick something" works.
    for (const item of payload) collect(item, ctx);
    return;
  }
  if (payload && typeof payload === "object") {
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        // Last write wins, which matches "use the most recent quote/bundle".
        ctx[key] = value;
      } else {
        collect(value, ctx);
      }
    }
  }
}

function resolveValue(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === "string" && value.startsWith("$ref:")) {
    const key = value.slice("$ref:".length);
    return context[key] ?? null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, context));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveValue(v, context);
    }
    return out;
  }
  return value;
}
