import { describe, expect, it } from "vitest";
import type { CompletionResult, LLM } from "../src/lib/agent/llm.js";
import { ScriptedLLM } from "../src/lib/agent/scripted.js";
import { MutationSet } from "../src/lib/hamperhub/mutations.js";
import { loadPolicyFromYaml } from "../src/lib/policy/load.js";
import { runScenario } from "../src/lib/runner/run.js";
import {
  SCRIPTED_GENERATED,
  generateScenarios,
  generatedScenarioSchema,
} from "../src/lib/scenarios/generate.js";
import { assembleSuite } from "../src/lib/scenarios/index.js";
import { REGRESSION_SCENARIOS } from "../src/lib/scenarios/regression.js";
import { POLICY_YAML } from "./helpers.js";

const policy = loadPolicyFromYaml(POLICY_YAML);

/** A stub that reports itself as real so the LLM generation path is exercised. */
function fakeRealLlm(
  respond: () => CompletionResult | Promise<CompletionResult>,
): LLM {
  return {
    name: "stub",
    isReal: true,
    async complete() {
      return respond();
    },
  };
}

function json(payload: unknown): CompletionResult {
  return { content: JSON.stringify(payload), toolCalls: [], model: "stub" };
}

describe("generatedScenarioSchema", () => {
  it("accepts a minimal scenario", () => {
    const result = generatedScenarioSchema.safeParse({
      id: "a-goal",
      title: "A goal",
      category: "normal",
      utterance: "Buy me something nice.",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown category", () => {
    const result = generatedScenarioSchema.safeParse({
      id: "a",
      title: "A",
      category: "chaotic",
      utterance: "x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing utterance", () => {
    const result = generatedScenarioSchema.safeParse({
      id: "a",
      title: "A",
      category: "normal",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-positive budget", () => {
    const result = generatedScenarioSchema.safeParse({
      id: "a",
      title: "A",
      category: "normal",
      utterance: "x",
      maxBudget: -5,
    });
    expect(result.success).toBe(false);
  });
});

describe("generateScenarios with the scripted model", () => {
  it("returns the deterministic set without a key", async () => {
    const scenarios = await generateScenarios({
      llm: new ScriptedLLM(),
      policy,
      count: 12,
    });
    expect(scenarios).toHaveLength(12);
    expect(scenarios.every((s) => s.id.startsWith("gen-"))).toBe(true);
  });

  it("honours a smaller count", async () => {
    const scenarios = await generateScenarios({
      llm: new ScriptedLLM(),
      policy,
      count: 3,
    });
    expect(scenarios).toHaveLength(3);
  });

  it("is reproducible across calls", async () => {
    const a = await generateScenarios({ llm: new ScriptedLLM(), policy });
    const b = await generateScenarios({ llm: new ScriptedLLM(), policy });
    expect(b.map((s) => s.id)).toEqual(a.map((s) => s.id));
  });

  it("never claims a target invariant, so detections stay honest", async () => {
    const scenarios = await generateScenarios({ llm: new ScriptedLLM(), policy });
    expect(scenarios.every((s) => s.targetsInvariant === null)).toBe(true);
  });

  it("covers more than one scenario category", async () => {
    const scenarios = await generateScenarios({ llm: new ScriptedLLM(), policy });
    const categories = new Set(scenarios.map((s) => s.category));
    expect(categories.size).toBeGreaterThanOrEqual(3);
    expect(categories).toContain("adversarial");
  });
});

describe("generateScenarios with a real model", () => {
  it("validates, dedupes and wraps model output", async () => {
    const duplicate = {
      id: "dup",
      title: "Dup",
      category: "normal",
      utterance: "Same request",
      maxBudget: 900,
    };
    const llm = fakeRealLlm(() =>
      json({
        scenarios: [
          duplicate,
          { ...duplicate, id: "dup-2" }, // same content → deduped
          { id: "bad", title: "Bad", category: "nonsense", utterance: "x" }, // invalid
          {
            id: "ok-2",
            title: "Second",
            category: "adversarial",
            utterance: "Stack every discount",
          },
        ],
      }),
    );

    const scenarios = await generateScenarios({ llm, policy, count: 10 });
    expect(scenarios.map((s) => s.id)).toEqual(["gen-dup", "gen-ok-2"]);
  });

  it("strips a model-supplied strategy so journeys run adaptively", async () => {
    const llm = fakeRealLlm(() =>
      json({
        scenarios: [
          {
            id: "sneaky",
            title: "Sneaky",
            category: "adversarial",
            utterance: "Do it",
            strategy: {
              label: "injected",
              steps: [{ tool: "create_checkout", args: { quote_id: "x" } }],
            },
          },
        ],
      }),
    );

    const scenarios = await generateScenarios({ llm, policy, count: 5 });
    expect(scenarios).toHaveLength(1);

    // With the strategy stripped and a stub model that returns no tool calls,
    // the journey must make no tool calls at all rather than replay the
    // injected plan.
    const result = await runScenario(scenarios[0]!, {
      mutations: MutationSet.fixed(),
    });
    expect(result.providerOrders).toBe(0);
    expect(result.error).toBeNull();
  });

  it("falls back to the scripted set when the model errors", async () => {
    const llm = fakeRealLlm(() => {
      throw new Error("upstream down");
    });
    const scenarios = await generateScenarios({ llm, policy, count: 6 });
    expect(scenarios).toHaveLength(6);
    expect(scenarios[0]?.id).toBe(`gen-${SCRIPTED_GENERATED[0]!.id}`);
  });

  it("falls back when the model returns unusable JSON", async () => {
    const llm = fakeRealLlm(() => ({
      content: "I would rather not.",
      toolCalls: [],
      model: "stub",
    }));
    const scenarios = await generateScenarios({ llm, policy, count: 4 });
    expect(scenarios).toHaveLength(4);
  });

  it("falls back when the model returns an empty scenario list", async () => {
    const llm = fakeRealLlm(() => json({ scenarios: [] }));
    const scenarios = await generateScenarios({ llm, policy, count: 5 });
    expect(scenarios).toHaveLength(5);
  });
});

describe("assembleSuite", () => {
  it("combines regression and generated journeys", async () => {
    const suite = await assembleSuite({
      llm: new ScriptedLLM(),
      policy,
      generatedCount: 12,
    });
    expect(suite.regressionCount).toBe(REGRESSION_SCENARIOS.length);
    expect(suite.generatedCount).toBe(12);
    expect(suite.scenarios).toHaveLength(REGRESSION_SCENARIOS.length + 12);
    expect(suite.generatorIsReal).toBe(false);
  });

  it("puts the fixed regression baseline first", async () => {
    const suite = await assembleSuite({ llm: new ScriptedLLM(), policy });
    expect(suite.scenarios[0]?.id).toBe(REGRESSION_SCENARIOS[0]!.id);
  });

  it("produces unique scenario ids", async () => {
    const suite = await assembleSuite({ llm: new ScriptedLLM(), policy });
    const ids = suite.scenarios.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reaches the 20-25 journey target", async () => {
    const suite = await assembleSuite({ llm: new ScriptedLLM(), policy });
    expect(suite.scenarios.length).toBeGreaterThanOrEqual(20);
    expect(suite.scenarios.length).toBeLessThanOrEqual(25);
  });
});

describe("agent-driven journeys", () => {
  it("finds no integration defect on the fixed integration", async () => {
    const scenarios = await generateScenarios({ llm: new ScriptedLLM(), policy });
    for (const scenario of scenarios) {
      const result = await runScenario(scenario, {
        mutations: MutationSet.fixed(),
      });
      expect(
        result.integrationDefects.map((d) => `${scenario.id}:${d.invariantId}`),
      ).toEqual([]);
      // The defect list and the headline disposition must never disagree.
      expect(result.disposition).not.toBe("unsafe_violation");
      expect(result.duplicatePayableOrders).toBe(0);
      expect(result.error).toBeNull();
    }
  });

  it("independently finds the stacking defect on the vulnerable integration", async () => {
    const scenarios = await generateScenarios({ llm: new ScriptedLLM(), policy });
    const stacking = scenarios.find((s) => s.id === "gen-grab-every-discount");
    expect(stacking).toBeDefined();

    const result = await runScenario(stacking!, {
      mutations: MutationSet.only("discount_stacking"),
    });
    // The generated scenario reaches further than the scripted regression case,
    // stacking three promotions rather than two.
    expect(result.firedInvariants).toContain("INV-DISCOUNT-CAP");
    expect(result.disposition).toBe("unsafe_violation");
  });

  it("completes normal generated journeys rather than blocking everything", async () => {
    const scenarios = await generateScenarios({ llm: new ScriptedLLM(), policy });
    const normal = scenarios.filter((s) => s.category === "normal");
    expect(normal.length).toBeGreaterThan(0);

    for (const scenario of normal) {
      const result = await runScenario(scenario, {
        mutations: MutationSet.fixed(),
      });
      expect(result.disposition).toBe("passed");
    }
  });
});
