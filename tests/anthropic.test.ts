import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicLLM } from "../src/lib/agent/anthropic.js";
import { LlmError } from "../src/lib/agent/llm.js";
import { llmPoolFromEnv } from "../src/lib/agent/factory.js";

/**
 * Wire-level tests for the Anthropic adapter.
 *
 * Everything here is a mapping that fails *silently* if it is wrong: a dropped
 * thinking block still returns a 200, merged tool results still look plausible,
 * and a mis-parsed tool call arrives at the Guard as an empty object. Each of
 * those would show up as "the agent behaved oddly" rather than as a bug in this
 * file, so they are pinned.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
});

interface Capture {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Replaces fetch with a queue of canned responses, recording each request. */
function stubFetch(
  responses: Array<{ status?: number; json: unknown }>,
): Capture[] {
  const captured: Capture[] = [];
  let call = 0;

  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const response = responses[Math.min(call, responses.length - 1)]!;
    call += 1;
    captured.push({
      url: String(url),
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return {
      ok: (response.status ?? 200) < 400,
      status: response.status ?? 200,
      text: async () => JSON.stringify(response.json),
    };
  }) as unknown as typeof fetch;

  return captured;
}

function textReply(text: string) {
  return {
    json: {
      model: "claude-opus-5",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
    },
  };
}

function build(overrides: Partial<{ model: string; baseUrl: string }> = {}) {
  return new AnthropicLLM({
    apiKey: "test-key",
    model: overrides.model ?? "claude-opus-5",
    baseUrl: overrides.baseUrl ?? "https://example.invalid/anthropic",
    maxRetries: 0,
  });
}

describe("request shape", () => {
  it("posts to /v1/messages with the native key and version headers", async () => {
    const captured = stubFetch([textReply("hi")]);
    await build().complete({ system: "be brief", messages: [] });

    const [request] = captured;
    expect(request!.url).toBe("https://example.invalid/anthropic/v1/messages");
    expect(request!.headers["x-api-key"]).toBe("test-key");
    expect(request!.headers["anthropic-version"]).toBe("2023-06-01");
    // Authorization would be the OpenAI dialect; sending it here is a bug.
    expect(request!.headers.Authorization).toBeUndefined();
  });

  it("lifts the system prompt out of the message list", async () => {
    const captured = stubFetch([textReply("hi")]);
    await build().complete({
      system: "you are a shopping agent",
      messages: [
        { role: "system", content: "should never reach the wire" },
        { role: "user", content: "buy me coffee" },
      ],
    });

    const body = captured[0]!.body;
    expect(body.system).toBe("you are a shopping agent");
    // A system turn inside `messages` is rejected by this API outright.
    expect(body.messages).toEqual([
      { role: "user", content: "buy me coffee" },
    ]);
  });

  it("always sends max_tokens, which this API requires", async () => {
    const captured = stubFetch([textReply("hi")]);
    await build().complete({ system: "s", messages: [] });
    expect(captured[0]!.body.max_tokens).toBeGreaterThan(0);
  });

  it("maps tools to input_schema rather than a function wrapper", async () => {
    const captured = stubFetch([textReply("hi")]);
    await build().complete({
      system: "s",
      messages: [],
      tools: [
        {
          name: "create_quote",
          description: "Quote a bundle.",
          parameters: { type: "object", properties: { bundle_id: { type: "string" } } },
        },
      ],
    });

    expect(captured[0]!.body.tools).toEqual([
      {
        name: "create_quote",
        description: "Quote a bundle.",
        input_schema: {
          type: "object",
          properties: { bundle_id: { type: "string" } },
        },
      },
    ]);
    expect(captured[0]!.body.tool_choice).toEqual({ type: "auto" });
  });

  it("asks for bare JSON when there is no JSON response mode to use", async () => {
    const captured = stubFetch([textReply("{}")]);
    await build().complete({
      system: "generate scenarios",
      messages: [],
      responseFormat: "json",
    });
    expect(String(captured[0]!.body.system)).toMatch(/single valid JSON value/i);
  });
});

describe("response parsing", () => {
  it("reads tool calls out of tool_use blocks with arguments intact", async () => {
    stubFetch([
      {
        json: {
          model: "claude-opus-5",
          content: [
            { type: "thinking", thinking: "", signature: "sig" },
            { type: "text", text: "Searching." },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "search_products",
              input: { query: "coffee", max_price: 500 },
            },
          ],
          stop_reason: "tool_use",
        },
      },
    ]);

    const result = await build().complete({ system: "s", messages: [] });

    expect(result.content).toBe("Searching.");
    expect(result.toolCalls).toEqual([
      {
        id: "toolu_1",
        name: "search_products",
        arguments: { query: "coffee", max_price: 500 },
      },
    ]);
    expect(result.model).toBe("claude-opus-5");
  });

  it("hands back the raw block list so the next turn can replay it", async () => {
    const blocks = [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "tool_use", id: "toolu_1", name: "search_products", input: {} },
    ];
    stubFetch([{ json: { model: "claude-opus-5", content: blocks } }]);

    const result = await build().complete({ system: "s", messages: [] });
    expect(result.providerRaw).toEqual(blocks);
  });

  it("treats a missing tool input as empty, leaving the Guard to reject it", async () => {
    stubFetch([
      {
        json: {
          model: "claude-opus-5",
          content: [{ type: "tool_use", id: "t", name: "create_quote" }],
        },
      },
    ]);
    const result = await build().complete({ system: "s", messages: [] });
    expect(result.toolCalls[0]!.arguments).toEqual({});
  });
});

describe("multi-turn tool conversations", () => {
  it("replays the provider's own blocks, keeping signed thinking intact", async () => {
    const blocks = [
      { type: "thinking", thinking: "weighing options", signature: "sig-abc" },
      { type: "tool_use", id: "toolu_1", name: "search_products", input: {} },
    ];
    const captured = stubFetch([textReply("done")]);

    await build().complete({
      system: "s",
      messages: [
        { role: "user", content: "buy coffee" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "toolu_1", name: "search_products", arguments: {} }],
          providerRaw: blocks,
        },
        { role: "tool", toolCallId: "toolu_1", content: "[]" },
      ],
    });

    const messages = captured[0]!.body.messages as Array<{
      role: string;
      content: unknown;
    }>;
    // Rebuilding from the neutral shape would have dropped the signature and with
    // it the model's reasoning chain.
    expect(messages[1]).toEqual({ role: "assistant", content: blocks });
  });

  it("rebuilds the assistant turn when no raw blocks were kept", async () => {
    const captured = stubFetch([textReply("done")]);

    await build().complete({
      system: "s",
      messages: [
        { role: "user", content: "buy coffee" },
        {
          role: "assistant",
          content: "Looking.",
          toolCalls: [
            { id: "toolu_1", name: "search_products", arguments: { query: "c" } },
          ],
        },
        { role: "tool", toolCallId: "toolu_1", content: "[]" },
      ],
    });

    const messages = captured[0]!.body.messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    expect(messages[1]!.content).toEqual([
      { type: "text", text: "Looking." },
      { type: "tool_use", id: "toolu_1", name: "search_products", input: { query: "c" } },
    ]);
  });

  it("merges consecutive tool results into one user turn", async () => {
    const captured = stubFetch([textReply("done")]);

    await build().complete({
      system: "s",
      messages: [
        { role: "user", content: "buy coffee" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "t1", name: "search_products", arguments: {} },
            { id: "t2", name: "get_product", arguments: {} },
          ],
        },
        { role: "tool", toolCallId: "t1", content: "[]" },
        { role: "tool", toolCallId: "t2", content: "{}" },
      ],
    });

    const messages = captured[0]!.body.messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    // Two user turns in a row breaks the alternation this API enforces, which is
    // exactly what happens the first time an agent calls two tools at once.
    expect(messages).toHaveLength(3);
    expect(messages[2]!.role).toBe("user");
    expect(messages[2]!.content.map((b) => b.tool_use_id)).toEqual(["t1", "t2"]);
  });
});

describe("provider quirks", () => {
  it("drops a deprecated temperature and retries, then remembers", async () => {
    const captured = stubFetch([
      {
        status: 400,
        json: {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "`temperature` is deprecated for this model.",
          },
        },
      },
      textReply("ok"),
      textReply("ok again"),
    ]);

    const llm = build();
    const result = await llm.complete({
      system: "s",
      messages: [],
      temperature: 0,
    });
    expect(result.content).toBe("ok");

    expect(captured[0]!.body.temperature).toBe(0);
    expect(captured[1]!.body).not.toHaveProperty("temperature");

    // Remembered, so the second call does not pay for the same 400 again.
    await llm.complete({ system: "s", messages: [], temperature: 0 });
    expect(captured).toHaveLength(3);
    expect(captured[2]!.body).not.toHaveProperty("temperature");
  });

  it("classifies an auth failure as config, so it is never retried", async () => {
    stubFetch([{ status: 401, json: { error: { message: "invalid key" } } }]);
    await expect(
      build().complete({ system: "s", messages: [] }),
    ).rejects.toMatchObject({ kind: "config", retryable: false });
  });

  it("refuses to construct without a key", () => {
    expect(
      () => new AnthropicLLM({ apiKey: "", model: "claude-opus-5" }),
    ).toThrow(LlmError);
  });
});

describe("the model pool", () => {
  it("is the scripted model when nothing real is configured", () => {
    vi.stubEnv("LLM_ADAPTER", "scripted");
    vi.stubEnv("LLM_API_KEY", "");
    vi.stubEnv("ANTHROPIC_MODEL", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    const pool = llmPoolFromEnv();
    expect(pool).toHaveLength(1);
    expect(pool[0]!.isReal).toBe(false);
  });

  it("holds both families when both are configured on one key", () => {
    vi.stubEnv("LLM_ADAPTER", "openai");
    vi.stubEnv("LLM_API_KEY", "shared-key");
    vi.stubEnv("LLM_MODEL", "gpt-5.6-sol");
    vi.stubEnv("ANTHROPIC_MODEL", "claude-opus-5");
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    const pool = llmPoolFromEnv();
    expect(pool.map((m) => m.name)).toEqual([
      "openai:gpt-5.6-sol",
      // Falls back to LLM_API_KEY rather than making you paste the secret twice.
      "anthropic:claude-opus-5",
    ]);
    expect(pool.every((m) => m.isReal)).toBe(true);
  });

  it("keeps the working provider when the other is half-configured", () => {
    vi.stubEnv("LLM_ADAPTER", "anthropic");
    vi.stubEnv("LLM_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-key");
    vi.stubEnv("ANTHROPIC_MODEL", "claude-opus-5");

    const pool = llmPoolFromEnv();
    expect(pool.map((m) => m.name)).toEqual(["anthropic:claude-opus-5"]);
  });
});
