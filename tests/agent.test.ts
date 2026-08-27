import { afterEach, describe, expect, it } from "vitest";
import { BuyerAgent } from "../src/lib/agent/buyer.js";
import { llmFromEnv, isRealLlmConfigured } from "../src/lib/agent/factory.js";
import {
  type CompletionRequest,
  type CompletionResult,
  type LLM,
  LlmError,
  extractJson,
} from "../src/lib/agent/llm.js";
import { ScriptedLLM, encodeStrategy } from "../src/lib/agent/scripted.js";
import { createEnvironment, createIntent } from "../src/lib/harness.js";
import { MutationSet } from "../src/lib/hamperhub/mutations.js";

const HAMPER = [
  { product_id: "p-coffee-arabica", quantity: 1 },
  { product_id: "p-choc-dark-vegan", quantity: 1 },
  { product_id: "p-mug-ceramic", quantity: 1 },
  { product_id: "p-card-handmade", quantity: 1 },
];

const HAPPY_STEPS = [
  { tool: "search_products", args: { require_vegan: true, max_price: 800 } },
  { tool: "create_bundle", args: { items: HAMPER, promo_codes: ["HAMPERCREDIT"] } },
  { tool: "create_quote", args: { bundle_id: "$ref:bundle_id" } },
  {
    tool: "approve_quote",
    args: {
      quote_id: "$ref:quote_id",
      approved_amount: "$ref:total",
      confirmation_text: "Yes, charge me.",
    },
  },
  {
    tool: "create_checkout",
    args: {
      quote_id: "$ref:quote_id",
      approval_receipt_id: "$ref:approval_receipt_id",
    },
  },
];

function agentEnv(mutations = MutationSet.fixed()) {
  const env = createEnvironment({ mutations });
  const intent = createIntent(env.ids, env.clock, {
    runId: "run_agent_test",
    utterance: "Vegan coffee birthday hamper under ₹1,500.",
    maxBudget: 1500,
    requireVegan: true,
  });
  env.guard.beginIntent(intent);
  return { env, intent };
}

describe("extractJson", () => {
  it("parses a bare object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses a fenced block", () => {
    expect(extractJson('```json\n{"a":[1,2]}\n```')).toEqual({ a: [1, 2] });
  });

  it("tolerates prose around the JSON", () => {
    expect(
      extractJson('Sure! Here you go:\n{"scenarios":[]}\nHope that helps.'),
    ).toEqual({ scenarios: [] });
  });

  it("ignores brackets inside strings", () => {
    expect(extractJson('{"s":"a}b{c"}')).toEqual({ s: "a}b{c" });
  });

  it("throws a parse error when there is no JSON", () => {
    expect(() => extractJson("no json here")).toThrow(LlmError);
  });

  it("throws on unterminated JSON", () => {
    expect(() => extractJson('{"a":1')).toThrow(/Unterminated/);
  });
});

describe("ScriptedLLM", () => {
  it("is not marked as a real provider", () => {
    expect(new ScriptedLLM().isReal).toBe(false);
  });

  it("returns no tool calls without a strategy", async () => {
    const result = await new ScriptedLLM().complete({
      system: "plain",
      messages: [],
    });
    expect(result.toolCalls).toHaveLength(0);
  });

  it("plays strategy steps in order, one per turn", async () => {
    const llm = new ScriptedLLM();
    const system = `base${encodeStrategy({
      label: "t",
      steps: [
        { tool: "search_products", args: {} },
        { tool: "create_bundle", args: { items: [] } },
      ],
    })}`;

    const first = await llm.complete({ system, messages: [] });
    expect(first.toolCalls[0]?.name).toBe("search_products");

    // Simulate one completed round trip.
    const second = await llm.complete({
      system,
      messages: [
        { role: "assistant", content: "", toolCalls: first.toolCalls },
        { role: "tool", toolCallId: "call_1", content: "{}" },
      ],
    });
    expect(second.toolCalls[0]?.name).toBe("create_bundle");
  });

  it("stops emitting tool calls once the strategy is exhausted", async () => {
    const llm = new ScriptedLLM();
    const system = `base${encodeStrategy({
      label: "t",
      steps: [{ tool: "search_products", args: {} }],
    })}`;
    const result = await llm.complete({
      system,
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "search_products", arguments: {} }] },
        { role: "tool", toolCallId: "c1", content: "[]" },
      ],
    });
    expect(result.toolCalls).toHaveLength(0);
    expect(result.content).toContain("Done");
  });

  it("resolves $ref arguments from prior tool responses", async () => {
    const llm = new ScriptedLLM();
    const system = `base${encodeStrategy({
      label: "t",
      steps: [
        { tool: "create_quote", args: { bundle_id: "x" } },
        { tool: "approve_quote", args: { quote_id: "$ref:quote_id" } },
      ],
    })}`;

    const result = await llm.complete({
      system,
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "create_quote", arguments: {} }] },
        { role: "tool", toolCallId: "c1", content: '{"quote_id":"quote_abc"}' },
      ],
    });
    expect(result.toolCalls[0]?.arguments).toEqual({ quote_id: "quote_abc" });
  });

  it("resolves an unknown $ref to null rather than leaving the token", async () => {
    const llm = new ScriptedLLM();
    const system = `base${encodeStrategy({
      label: "t",
      steps: [{ tool: "create_quote", args: { bundle_id: "$ref:nope" } }],
    })}`;
    const result = await llm.complete({ system, messages: [] });
    expect(result.toolCalls[0]?.arguments).toEqual({ bundle_id: null });
  });
});

describe("BuyerAgent", () => {
  it("drives a full journey through the Guard", async () => {
    const { env, intent } = agentEnv();
    const agent = new BuyerAgent({
      llm: new ScriptedLLM(),
      guard: env.guard,
      systemSuffix: encodeStrategy({ label: "happy", steps: HAPPY_STEPS }),
    });

    const result = await agent.run(intent);

    expect(result.transcript.map((t) => t.tool)).toEqual([
      "search_products",
      "create_bundle",
      "create_quote",
      "approve_quote",
      "create_checkout",
    ]);
    expect(result.transcript.every((t) => t.ok)).toBe(true);
    expect(env.guard.recordedViolations()).toHaveLength(0);
    expect(env.fake?.allOrders()).toHaveLength(1);
  });

  it("exposes the last tool result so self-rejection is detectable", async () => {
    const { env, intent } = agentEnv();
    const agent = new BuyerAgent({
      llm: new ScriptedLLM(),
      guard: env.guard,
      // Checkout without an approval receipt: the merchant must refuse.
      systemSuffix: encodeStrategy({
        label: "no receipt",
        steps: [
          ...HAPPY_STEPS.slice(0, 3),
          { tool: "create_checkout", args: { quote_id: "$ref:quote_id" } },
        ],
      }),
    });

    const result = await agent.run(intent);

    expect(result.lastResult).toBeDefined();
    expect(result.lastResult?.ok).toBe(false);
    if (result.lastResult?.ok === false) {
      expect(result.lastResult.decision).toBe("rejected");
    }
  });

  it("respects the tool-call budget", async () => {
    const { env, intent } = agentEnv();
    const agent = new BuyerAgent({
      llm: new ScriptedLLM(),
      guard: env.guard,
      maxToolCalls: 2,
      systemSuffix: encodeStrategy({ label: "happy", steps: HAPPY_STEPS }),
    });

    const result = await agent.run(intent);
    expect(result.toolCalls).toBe(2);
    expect(result.stopReason).toBe("max_tool_calls");
  });

  it("rejects a tool the merchant does not expose", async () => {
    const { env, intent } = agentEnv();
    const rogue: LLM = {
      name: "rogue",
      isReal: false,
      async complete(): Promise<CompletionResult> {
        return {
          content: "",
          toolCalls: [{ id: "c1", name: "transfer_funds", arguments: {} }],
          model: "rogue",
        };
      },
    };

    const agent = new BuyerAgent({ llm: rogue, guard: env.guard, maxToolCalls: 1 });
    const result = await agent.run(intent);

    expect(result.transcript[0]?.ok).toBe(false);
    expect(result.transcript[0]?.summary).toContain("Unknown tool");
    expect(env.fake?.allOrders()).toHaveLength(0);
  });

  it("rejects malformed tool arguments via the Guard's schema", async () => {
    const { env, intent } = agentEnv();
    const sloppy: LLM = {
      name: "sloppy",
      isReal: false,
      async complete(): Promise<CompletionResult> {
        return {
          content: "",
          // quantity must be a positive integer.
          toolCalls: [
            {
              id: "c1",
              name: "create_bundle",
              arguments: { items: [{ product_id: "p-mug-ceramic", quantity: -3 }] },
            },
          ],
          model: "sloppy",
        };
      },
    };

    const agent = new BuyerAgent({ llm: sloppy, guard: env.guard, maxToolCalls: 1 });
    const result = await agent.run(intent);

    expect(result.transcript[0]?.ok).toBe(false);
    expect(result.transcript[0]?.summary).toContain("invalid");
  });

  it("stops cleanly when the model errors", async () => {
    const { env, intent } = agentEnv();
    const broken: LLM = {
      name: "broken",
      isReal: false,
      async complete(): Promise<CompletionResult> {
        throw new LlmError("upstream exploded", "provider", false);
      },
    };

    const agent = new BuyerAgent({ llm: broken, guard: env.guard });
    const result = await agent.run(intent);

    expect(result.stopReason).toBe("llm_error");
    expect(result.finalMessage).toContain("upstream exploded");
    expect(env.fake?.allOrders()).toHaveLength(0);
  });

  it("feeds failures back to the model so it can adapt", async () => {
    const { env, intent } = agentEnv();
    const seen: CompletionRequest[] = [];
    let turn = 0;
    const watcher: LLM = {
      name: "watcher",
      isReal: false,
      async complete(request): Promise<CompletionResult> {
        seen.push(request);
        turn += 1;
        if (turn === 1) {
          return {
            content: "",
            toolCalls: [
              { id: "c1", name: "create_quote", arguments: { bundle_id: "nope" } },
            ],
            model: "watcher",
          };
        }
        return { content: "giving up", toolCalls: [], model: "watcher" };
      },
    };

    const agent = new BuyerAgent({ llm: watcher, guard: env.guard });
    await agent.run(intent);

    // The second request must contain the tool failure from the first.
    const toolMessage = seen[1]?.messages.find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    const payload = JSON.parse(toolMessage!.content) as {
      error: boolean;
      reason: string;
    };
    expect(payload.error).toBe(true);
    expect(payload.reason).toContain("No such bundle");
  });
});

describe("llmFromEnv", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("defaults to the scripted model with no configuration", () => {
    delete process.env.LLM_ADAPTER;
    delete process.env.LLM_API_KEY;
    const llm = llmFromEnv();
    expect(llm.name).toBe("scripted");
    expect(llm.isReal).toBe(false);
    expect(isRealLlmConfigured()).toBe(false);
  });

  it("builds a real adapter when a key is present", () => {
    process.env.LLM_ADAPTER = "openai";
    process.env.LLM_API_KEY = "sk-test";
    process.env.LLM_MODEL = "gpt-4o-mini";
    const llm = llmFromEnv();
    expect(llm.isReal).toBe(true);
    expect(llm.name).toContain("gpt-4o-mini");
    expect(isRealLlmConfigured()).toBe(true);
  });

  it("explains itself when openai is requested without a key", () => {
    process.env.LLM_ADAPTER = "openai";
    delete process.env.LLM_API_KEY;
    expect(() => llmFromEnv()).toThrow(/requires LLM_API_KEY/);
  });

  it("rejects an unknown adapter", () => {
    process.env.LLM_ADAPTER = "telepathy";
    expect(() => llmFromEnv()).toThrow(/Unknown LLM_ADAPTER/);
  });
});
