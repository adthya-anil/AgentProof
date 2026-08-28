/**
 * The LLM boundary.
 *
 * AgentProof needs a model in two places — driving the buyer agent and
 * generating scenarios — but neither should depend on a specific provider or on
 * the network being reachable. This interface is the seam.
 *
 * Three implementations back it: a `ScriptedLLM` that is fully deterministic and
 * needs no key (so demos, tests and CI are reproducible byte-for-byte), an
 * `OpenAICompatibleLLM` for any chat-completions endpoint, and an `AnthropicLLM`
 * for the Messages API. The rest of the codebase cannot tell which is in use.
 *
 * Two real families is not redundancy. The agents that will actually shop a
 * merchant's store are not all one model, so a preflight run that only ever sends
 * one is testing a narrower world than the one the merchant ships into.
 */

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Present on assistant messages that requested tool calls. */
  toolCalls?: LlmToolCall[];
  /** Present on tool messages: which call this responds to. */
  toolCallId?: string;
  name?: string;
  /**
   * The provider's own representation of this turn, opaque to everything except
   * the adapter that produced it.
   *
   * This exists because some providers cannot losslessly rebuild an assistant
   * turn from the neutral shape above. Anthropic's reasoning models emit a signed
   * `thinking` block alongside a tool call, and reconstructing the turn without it
   * throws away the reasoning chain mid-purchase. The adapter round-trips its own
   * blocks through here; nothing else may read it.
   */
  providerRaw?: unknown;
}

export interface LlmToolCall {
  id: string;
  name: string;
  /** Parsed arguments. Never trusted — always re-validated against a schema. */
  arguments: Record<string, unknown>;
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CompletionRequest {
  system: string;
  messages: ChatMessage[];
  tools?: LlmToolDefinition[];
  /** When set, the model must answer as JSON matching this description. */
  responseFormat?: "json" | "text";
  temperature?: number;
  maxTokens?: number;
}

export interface CompletionResult {
  content: string;
  toolCalls: LlmToolCall[];
  /** Provider/model that produced this, surfaced in the report. */
  model: string;
  /** See `ChatMessage.providerRaw`. Echo it back on the next turn, untouched. */
  providerRaw?: unknown;
}

export interface LLM {
  readonly name: string;
  /** True when calls hit a real provider rather than the scripted stub. */
  readonly isReal: boolean;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export class LlmError extends Error {
  /**
   * True for a 429.
   *
   * Distinguished from other retryable failures because it needs a completely
   * different wait: providers meter per minute, so the sub-second backoff that
   * suits a transient blip guarantees the retry lands inside the same window.
   */
  readonly rateLimited: boolean;
  /** The server's own `Retry-After`, in ms, when it sent one. */
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    readonly kind: "config" | "network" | "provider" | "parse",
    readonly retryable: boolean,
    options: { rateLimited?: boolean; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "LlmError";
    this.rateLimited = options.rateLimited ?? false;
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
  }
}

/** Extracts the first JSON object or array from a possibly-fenced string. */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : trimmed;
  const start = candidate.search(/[[{]/);
  if (start === -1) {
    throw new LlmError(`No JSON found in model output`, "parse", false);
  }
  // Walk to the matching close bracket to tolerate trailing prose.
  const open = candidate[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i += 1) {
    const ch = candidate[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch (error) {
          throw new LlmError(
            `Malformed JSON in model output: ${
              error instanceof Error ? error.message : String(error)
            }`,
            "parse",
            false,
          );
        }
      }
    }
  }
  throw new LlmError("Unterminated JSON in model output", "parse", false);
}
