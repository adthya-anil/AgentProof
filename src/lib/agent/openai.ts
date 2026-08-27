import {
  type ChatMessage,
  type CompletionRequest,
  type CompletionResult,
  type LLM,
  LlmError,
  type LlmToolCall,
} from "./llm.js";

export interface OpenAICompatibleConfig {
  apiKey: string;
  model: string;
  /** Defaults to OpenAI; override for Azure, Together, Groq, local, etc. */
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

/**
 * Adapter for any OpenAI-style `/chat/completions` endpoint with tool calling.
 *
 * Kept intentionally thin: it maps our provider-neutral message and tool shapes
 * onto the wire format and back. It never decides anything about commerce —
 * that is the Guard's job — it only relays what the model wanted to do.
 *
 * Transient failures (timeouts, 429, 5xx) are retried with backoff so a flaky
 * network does not abort a whole preflight run; parse and auth errors are not
 * retried because retrying will not fix them.
 */
export class OpenAICompatibleLLM implements LLM {
  readonly name: string;
  readonly isReal = true;

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(private readonly config: OpenAICompatibleConfig) {
    if (!config.apiKey) {
      throw new LlmError("LLM API key is required", "config", false);
    }
    this.name = `openai:${config.model}`;
    this.baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(
      /\/$/,
      "",
    );
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.maxRetries = config.maxRetries ?? 2;
  }

  /**
   * Provider quirks discovered at runtime rather than configured up front.
   *
   * "OpenAI-compatible" is a spectrum. Azure's reasoning deployments reject
   * `temperature` unless it is the default and require `max_completion_tokens`
   * in place of `max_tokens`; other gateways differ again. Rather than ask the
   * operator to know which dialect their endpoint speaks, the adapter reads the
   * 400 it gets back, adapts, and remembers — so the first call self-heals and
   * every later call is already correct.
   */
  private omitTemperature = false;
  private useMaxCompletionTokens = false;

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    let json: Record<string, unknown>;
    try {
      json = await this.requestWithRetry(this.buildBody(request));
    } catch (error) {
      const adapted = this.adaptToProviderComplaint(error);
      if (!adapted) throw error;
      json = await this.requestWithRetry(this.buildBody(request));
    }
    return this.parseCompletion(json);
  }

  /**
   * Turns an unsupported-parameter 400 into a retry that omits or renames it.
   * Returns false when the error is something we cannot work around.
   */
  private adaptToProviderComplaint(error: unknown): boolean {
    if (!(error instanceof LlmError) || error.kind !== "provider") return false;
    const message = error.message.toLowerCase();

    if (!this.omitTemperature && message.includes("temperature")) {
      this.omitTemperature = true;
      return true;
    }
    if (!this.useMaxCompletionTokens && message.includes("max_tokens")) {
      this.useMaxCompletionTokens = true;
      return true;
    }
    return false;
  }

  private buildBody(request: CompletionRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: this.toWireMessages(request),
    };

    // Determinism matters for reproducible runs, so temperature is sent when the
    // provider tolerates it and quietly dropped when it does not.
    if (!this.omitTemperature) body.temperature = request.temperature ?? 0;

    if (request.maxTokens) {
      if (this.useMaxCompletionTokens) {
        body.max_completion_tokens = request.maxTokens;
      } else {
        body.max_tokens = request.maxTokens;
      }
    }
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
      body.tool_choice = "auto";
    }
    if (request.responseFormat === "json") {
      body.response_format = { type: "json_object" };
    }
    return body;
  }

  private parseCompletion(json: Record<string, unknown>): CompletionResult {
    const choice = (json.choices as Array<Record<string, unknown>>)?.[0];
    if (!choice) {
      throw new LlmError("Model returned no choices", "provider", false);
    }
    const message = choice.message as Record<string, unknown>;

    const toolCalls: LlmToolCall[] = Array.isArray(message.tool_calls)
      ? (message.tool_calls as Array<Record<string, unknown>>).map((call) => {
          const fn = call.function as { name: string; arguments: string };
          let args: Record<string, unknown> = {};
          try {
            args = fn.arguments ? JSON.parse(fn.arguments) : {};
          } catch {
            // A model that emits malformed arguments is a finding, not a crash:
            // pass them through empty so the Guard's schema check rejects them.
            args = {};
          }
          return { id: String(call.id ?? fn.name), name: fn.name, arguments: args };
        })
      : [];

    return {
      content: typeof message.content === "string" ? message.content : "",
      toolCalls,
      model: String(json.model ?? this.config.model),
    };
  }

  private toWireMessages(request: CompletionRequest): unknown[] {
    const wire: unknown[] = [{ role: "system", content: request.system }];
    for (const message of request.messages) {
      wire.push(this.toWireMessage(message));
    }
    return wire;
  }

  private toWireMessage(message: ChatMessage): Record<string, unknown> {
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        })),
      };
    }
    if (message.role === "tool") {
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.toolCallId,
      };
    }
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
        if (attempt < this.maxRetries) {
          await sleep(250 * 2 ** attempt);
        }
      }
    }
    throw lastError;
  }

  private async request(body: unknown): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new LlmError(
          `LLM request failed with ${response.status}: ${text.slice(0, 300)}`,
          response.status === 401 || response.status === 403
            ? "config"
            : "provider",
          response.status === 429 || response.status >= 500,
        );
      }
      return JSON.parse(text) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof LlmError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new LlmError(
          `LLM request timed out after ${this.timeoutMs}ms`,
          "network",
          true,
        );
      }
      throw new LlmError(
        `LLM network error: ${error instanceof Error ? error.message : String(error)}`,
        "network",
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
