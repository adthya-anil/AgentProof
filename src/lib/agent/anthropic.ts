import {
  type ChatMessage,
  type CompletionRequest,
  type CompletionResult,
  type LLM,
  LlmError,
  type LlmToolCall,
} from "./llm.js";

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  /** Base URL of the Messages API host, e.g. an Azure AI Foundry endpoint. */
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Anthropic requires this; pinned so a server-side default cannot shift. */
  apiVersion?: string;
}

/**
 * Adapter for the Anthropic Messages API, including Azure AI Foundry's hosted
 * Anthropic endpoint.
 *
 * A second adapter earns its place because the buyer agents that will actually
 * shop a merchant's store are not all one model. Two families sharing one
 * interface means a preflight run can send genuinely different agents at the
 * same integration, and a report can say *which* model found a hole — which is
 * the difference between "an agent can stack these discounts" and "this specific
 * model does".
 *
 * Same contract as the OpenAI adapter: it maps message and tool shapes onto the
 * wire format and back, and decides nothing about commerce.
 */
export class AnthropicLLM implements LLM {
  readonly name: string;
  readonly isReal = true;

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly apiVersion: string;

  constructor(private readonly config: AnthropicConfig) {
    if (!config.apiKey) {
      throw new LlmError("Anthropic API key is required", "config", false);
    }
    this.name = `anthropic:${config.model}`;
    this.baseUrl = (config.baseUrl ?? "https://api.anthropic.com").replace(
      /\/+$/,
      "",
    );
    // Reasoning models think before they answer, and a full tool-calling turn on
    // a 17-product catalogue is not fast. A 30s ceiling would time out healthy
    // calls and log them as provider faults.
    this.timeoutMs = config.timeoutMs ?? 120_000;
    // Three, not two: a rate-limited retry can now wait out a full minute, so a
    // journey that hits the window twice still has an attempt left.
    this.maxRetries = config.maxRetries ?? 3;
    this.apiVersion = config.apiVersion ?? "2023-06-01";
  }

  /**
   * Discovered at runtime, not configured.
   *
   * Newer deployments reject `temperature` outright — Azure's `claude-opus-5`
   * answers a perfectly ordinary request with "`temperature` is deprecated for
   * this model". Asking the operator to know that is unreasonable, so the adapter
   * reads the 400, drops the field, retries once, and remembers.
   */
  private omitTemperature = false;

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    let json: Record<string, unknown>;
    try {
      json = await this.requestWithRetry(this.buildBody(request));
    } catch (error) {
      if (!this.adaptToProviderComplaint(error)) throw error;
      json = await this.requestWithRetry(this.buildBody(request));
    }
    return this.parseCompletion(json);
  }

  private adaptToProviderComplaint(error: unknown): boolean {
    if (!(error instanceof LlmError) || error.kind !== "provider") return false;
    if (!this.omitTemperature && /temperature/i.test(error.message)) {
      this.omitTemperature = true;
      return true;
    }
    return false;
  }

  private buildBody(request: CompletionRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      // Required by this API, unlike chat-completions. A journey needs room for
      // a tool call plus the reasoning that precedes it.
      max_tokens: request.maxTokens ?? 4096,
      system: this.buildSystem(request),
      messages: this.toWireMessages(request.messages),
    };

    if (!this.omitTemperature && request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
      body.tool_choice = { type: "auto" };
    }

    return body;
  }

  /**
   * There is no JSON response mode here, so a JSON request is enforced by
   * instruction. `extractJson` already tolerates fences and trailing prose, which
   * is what makes that safe.
   */
  private buildSystem(request: CompletionRequest): string {
    if (request.responseFormat !== "json") return request.system;
    return (
      `${request.system}\n\n` +
      "Respond with a single valid JSON value and nothing else. No prose, no " +
      "explanation, no markdown fences."
    );
  }

  private parseCompletion(json: Record<string, unknown>): CompletionResult {
    const blocks = Array.isArray(json.content)
      ? (json.content as Array<Record<string, unknown>>)
      : [];

    const text = blocks
      .filter((block) => block.type === "text")
      .map((block) => String(block.text ?? ""))
      .join("");

    const toolCalls: LlmToolCall[] = blocks
      .filter((block) => block.type === "tool_use")
      .map((block) => ({
        id: String(block.id ?? block.name),
        name: String(block.name),
        // Already an object on the wire — no JSON string to mis-parse, though the
        // Guard re-validates it against the tool schema regardless.
        arguments:
          block.input && typeof block.input === "object"
            ? (block.input as Record<string, unknown>)
            : {},
      }));

    return {
      content: text,
      toolCalls,
      model: String(json.model ?? this.config.model),
      // Handed back so the next turn can replay the assistant block list exactly,
      // signed thinking blocks included. See `toWireMessage`.
      providerRaw: blocks,
    };
  }

  private toWireMessages(messages: readonly ChatMessage[]): unknown[] {
    const wire: Array<{ role: string; content: unknown }> = [];

    for (const message of messages) {
      const converted = this.toWireMessage(message);
      if (!converted) continue;

      // Tool results arrive as separate `tool` messages but belong to a single
      // user turn on this API. Merging them keeps strict role alternation, which
      // the API enforces and which breaks the moment an agent calls two tools.
      const previous = wire[wire.length - 1];
      if (
        previous &&
        previous.role === "user" &&
        converted.role === "user" &&
        Array.isArray(previous.content) &&
        Array.isArray(converted.content)
      ) {
        previous.content = [...previous.content, ...converted.content];
        continue;
      }
      wire.push(converted);
    }

    return wire;
  }

  private toWireMessage(
    message: ChatMessage,
  ): { role: string; content: unknown } | null {
    if (message.role === "system") {
      // Handled by the top-level `system` field; a system turn here is an error.
      return null;
    }

    if (message.role === "tool") {
      return {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId,
            content: message.content,
          },
        ],
      };
    }

    if (message.role === "assistant" && message.toolCalls?.length) {
      /**
       * Replay the provider's own blocks when we have them.
       *
       * Reconstructing the turn from our neutral shape would drop the signed
       * `thinking` block this model emits before a tool call, discarding the
       * reasoning chain the model built up. Echoing the original blocks back
       * keeps the conversation intact across a multi-step purchase.
       */
      if (Array.isArray(message.providerRaw) && message.providerRaw.length > 0) {
        return { role: "assistant", content: message.providerRaw };
      }

      const content: Array<Record<string, unknown>> = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.toolCalls) {
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.arguments,
        });
      }
      return { role: "assistant", content };
    }

    // An empty string is rejected outright, and an assistant turn with nothing in
    // it carries no information anyway.
    if (!message.content) return null;
    return { role: message.role, content: message.content };
  }

  private async requestWithRetry(
    body: unknown,
  ): Promise<Record<string, unknown>> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.request(body);
      } catch (error) {
        lastError = error;
        if (error instanceof LlmError && !error.retryable) throw error;
        if (attempt >= this.maxRetries) break;
        await sleep(this.backoffMs(error, attempt));
      }
    }
    throw lastError;
  }

  /**
   * How long to wait before retrying.
   *
   * Exponential backoff from 500ms is right for a blip and useless for a rate
   * limit. Azure meters this deployment per *minute* — "Rate limit of 40000 per
   * 60s exceeded" — so retrying after 0.5s and again after 1s just burns both
   * attempts inside the same window and loses the journey. Measured: two
   * perturbation journeys dropped that way in a single suite.
   *
   * A 429 therefore waits out the window, preferring the server's own
   * `Retry-After` when it sends one. Capped, because a suite that stalls for five
   * minutes on one journey is its own kind of failure.
   */
  private backoffMs(error: unknown, attempt: number): number {
    const retryAfter = error instanceof LlmError ? error.retryAfterMs : undefined;
    if (retryAfter !== undefined) {
      return Math.min(retryAfter + 500, RATE_LIMIT_MAX_WAIT_MS);
    }
    if (error instanceof LlmError && error.rateLimited) {
      // No hint given, so assume the usual per-minute window.
      return Math.min(20_000 * (attempt + 1), RATE_LIMIT_MAX_WAIT_MS);
    }
    return 500 * 2 ** attempt;
  }

  private async request(body: unknown): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          // Azure AI Foundry accepts the native Anthropic header, so one code
          // path serves both the direct API and the Foundry deployment.
          "x-api-key": this.config.apiKey,
          "anthropic-version": this.apiVersion,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        const retryAfterMs = parseRetryAfter(
          response.headers.get("retry-after"),
        );
        throw new LlmError(
          `Anthropic request failed with ${response.status}: ${describeError(text)}`,
          response.status === 401 || response.status === 403
            ? "config"
            : "provider",
          response.status === 429 || response.status >= 500,
          {
            rateLimited: response.status === 429,
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          },
        );
      }
      return JSON.parse(text) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof LlmError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new LlmError(
          `Anthropic request timed out after ${this.timeoutMs}ms`,
          "network",
          true,
        );
      }
      throw new LlmError(
        `Anthropic network error: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "network",
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Pulls the human-readable message out of an error envelope.
 *
 * Worth the few lines: `adaptToProviderComplaint` matches on the message text, so
 * a raw JSON blob would hide the word "temperature" behind escaping and the
 * self-healing retry would never fire.
 */
function describeError(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // Not JSON. The raw body is the best available description.
  }
  return text.slice(0, 300);
}

/** Never wait longer than this for a rate limit; a stalled suite is a failure too. */
const RATE_LIMIT_MAX_WAIT_MS = 70_000;

/**
 * Reads `Retry-After`, which may be either a seconds count or an HTTP date.
 * Returns undefined for anything unparseable rather than guessing.
 */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;

  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());

  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
