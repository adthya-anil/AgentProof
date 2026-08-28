import { describe, expect, it } from "vitest";
import type { CompletionResult, LLM } from "../src/lib/agent/llm.js";
import { ScriptedLLM } from "../src/lib/agent/scripted.js";
import { MutationSet } from "../src/lib/hamperhub/mutations.js";
import { loadPolicyFromFile } from "../src/lib/policy/load.js";
import { runScenario, runSuite } from "../src/lib/runner/run.js";
import { agentDrivenScenarios } from "../src/lib/scenarios/agentDriven.js";
import { assembleSuite } from "../src/lib/scenarios/index.js";
import { PERTURBATION_SCENARIOS } from "../src/lib/scenarios/perturbations.js";
import { REGRESSION_SCENARIOS } from "../src/lib/scenarios/regression.js";

/**
 * Guards the claims the product makes about its own numbers.
 *
 * Every assertion here exists because the opposite would be a flattering lie: a
 * stalled agent counted as a safe rejection, a scripted replay presented as a
 * live model, a recall figure that moves because the model chose differently.
 */

/** A model that always asks for another search — it never finishes. */
class BrowsesForever implements LLM {
  readonly name = "browses-forever";
  readonly isReal = false;
  calls = 0;
  /** Set when the harness told the model how much budget was left. */
  sawBudgetWarning = false;

  async complete(request: {
    messages: Array<{ role: string; content?: string }>;
  }): Promise<CompletionResult> {
    this.calls += 1;
    for (const message of request.messages) {
      if (
        message.role === "tool" &&
        typeof message.content === "string" &&
        message.content.includes("tool_calls_remaining")
      ) {
        this.sawBudgetWarning = true;
      }
    }
    return {
      content: "",
      toolCalls: [
        {
          id: `call_${this.calls}`,
          name: "search_products",
          arguments: { query: "coffee" },
        },
      ],
      model: this.name,
    };
  }
}

/** Narrows away `| undefined` so the assertion, not the indexing, fails. */
function only<T>(items: readonly T[]): T {
  expect(items).toHaveLength(1);
  return items[0]!;
}

describe("who drove the journey", () => {
  it("labels the fixed suites deterministic and the live variants as agent", () => {
    for (const scenario of REGRESSION_SCENARIOS) {
      expect(scenario.driver).toBe("deterministic");
    }
    // Perturbations route through an agent, but the tool sequence is scripted so
    // the transport fault has something stable to act on. Calling them "live"
    // would overstate what they prove.
    for (const scenario of PERTURBATION_SCENARIOS) {
      expect(scenario.driver).toBe("deterministic");
    }
    for (const scenario of agentDrivenScenarios({ llm: new ScriptedLLM() })) {
      expect(scenario.driver).toBe("agent");
    }
  });

  it("carries the driver and the model through to every journey result", async () => {
    const live = only(
      agentDrivenScenarios({
        llm: new ScriptedLLM(),
        only: ["reg-01-normal"],
      }),
    );
    const journey = await runScenario(live, { mutations: MutationSet.fixed() });
    expect(journey.driver).toBe("agent");
    expect(journey.model).toBe("scripted");

    const fixed = await runScenario(REGRESSION_SCENARIOS[0]!, {
      mutations: MutationSet.fixed(),
    });
    expect(fixed.driver).toBe("deterministic");
    // No model drove it, and claiming one did would be a lie.
    expect(fixed.model).toBeNull();
  });

  it("keeps the same buyer goal and target invariant as the fixed original", () => {
    const live = agentDrivenScenarios({ llm: new ScriptedLLM() });
    expect(live).toHaveLength(REGRESSION_SCENARIOS.length);
    for (const [index, scenario] of live.entries()) {
      const original = REGRESSION_SCENARIOS[index]!;
      expect(scenario.intent).toEqual(original.intent);
      expect(scenario.targetsInvariant).toBe(original.targetsInvariant);
      // Distinct id, so the two never overwrite each other in a report.
      expect(scenario.id).not.toBe(original.id);
    }
  });
});

describe("more than one model", () => {
  /**
   * The scripted model under a different name.
   *
   * Wrapped rather than subclassed: `ScriptedLLM.name` is a literal type, which is
   * a feature — it stops production code from passing a stub off as a real model.
   */
  class NamedScripted implements LLM {
    private readonly inner = new ScriptedLLM();
    readonly isReal = false;
    constructor(readonly name: string) {}
    async complete(
      request: Parameters<LLM["complete"]>[0],
    ): Promise<CompletionResult> {
      const result = await this.inner.complete(request);
      return { ...result, model: this.name };
    }
  }

  it("attempts every goal with every model, under distinct ids", () => {
    const scenarios = agentDrivenScenarios({
      llms: [new NamedScripted("openai:gpt-x"), new NamedScripted("anthropic:claude-y")],
      only: ["reg-09-discount-stacking"],
    });

    expect(scenarios).toHaveLength(2);
    expect(new Set(scenarios.map((s) => s.id)).size).toBe(2);
    expect(scenarios.map((s) => s.assignedModel)).toEqual([
      "openai:gpt-x",
      "anthropic:claude-y",
    ]);
    // Same buyer request both times, or the comparison is meaningless.
    expect(scenarios[0]!.intent).toEqual(scenarios[1]!.intent);
    expect(scenarios[0]!.targetsInvariant).toBe(scenarios[1]!.targetsInvariant);
  });

  it("breaks the suite down per model instead of averaging them", async () => {
    const scenarios = agentDrivenScenarios({
      llms: [new NamedScripted("model-a"), new NamedScripted("model-b")],
      only: ["reg-01-normal", "reg-09-discount-stacking"],
    });
    const suite = await runSuite(scenarios, {
      mutations: MutationSet.vulnerable(),
    });

    expect(suite.byModel.map((m) => m.model)).toEqual(["model-a", "model-b"]);
    for (const entry of suite.byModel) {
      expect(entry.journeys).toBe(2);
    }
    expect(suite.byModel.reduce((sum, m) => sum + m.journeys, 0)).toBe(
      suite.journeys.length,
    );
  });

  it("attributes nothing to a model on a deterministic run", async () => {
    const suite = await runSuite(REGRESSION_SCENARIOS.slice(0, 3), {
      mutations: MutationSet.fixed(),
    });
    expect(suite.byModel).toEqual([]);
    expect(suite.agentDriven).toBe(0);
  });
});

describe("an agent that ran out of road", () => {
  it("is reported inconclusive, never as a safe rejection", async () => {
    const scenario = only(
      agentDrivenScenarios({
        llm: new BrowsesForever(),
        maxToolCalls: 6,
        only: ["reg-01-normal"],
      }),
    );
    const journey = await runScenario(scenario, {
      mutations: MutationSet.fixed(),
    });

    expect(journey.disposition).toBe("inconclusive");
    expect(journey.note).toContain("max_tool_calls");
  });

  it("is told how much budget is left before the budget runs out", async () => {
    const llm = new BrowsesForever();
    const scenario = only(
      agentDrivenScenarios({
        llm,
        maxToolCalls: 6,
        only: ["reg-01-normal"],
      }),
    );
    await runScenario(scenario, { mutations: MutationSet.fixed() });
    expect(llm.sawBudgetWarning).toBe(true);
  });

  it("is counted separately in the suite totals", async () => {
    const stalling = agentDrivenScenarios({
      llm: new BrowsesForever(),
      maxToolCalls: 4,
      only: ["reg-01-normal", "reg-02-max-amount"],
    });
    const suite = await runSuite(stalling, { mutations: MutationSet.fixed() });

    expect(suite.inconclusive).toBe(2);
    expect(suite.safelyRejected).toBe(0);
    expect(suite.passed).toBe(0);
    expect(suite.agentDriven).toBe(2);
  });
});

describe("suite composition", () => {
  it("defaults to the deterministic suite so recall stays reproducible", async () => {
    const policy = loadPolicyFromFile();
    const suite = await assembleSuite({
      llm: new ScriptedLLM(),
      policy,
      generatedCount: 0,
    });
    expect(suite.liveCount).toBe(0);
    expect(
      suite.scenarios.filter((s) => s.driver === "deterministic"),
    ).toHaveLength(REGRESSION_SCENARIOS.length + PERTURBATION_SCENARIOS.length);
  });

  it("adds a live-agent replay of every regression goal when asked", async () => {
    const policy = loadPolicyFromFile();
    const suite = await assembleSuite({
      llm: new ScriptedLLM(),
      policy,
      generatedCount: 0,
      mode: "both",
    });
    expect(suite.liveCount).toBe(REGRESSION_SCENARIOS.length);
    expect(suite.regressionCount).toBe(REGRESSION_SCENARIOS.length);
  });

  it("drops the fixed halves entirely in agent-only mode", async () => {
    const policy = loadPolicyFromFile();
    const suite = await assembleSuite({
      llm: new ScriptedLLM(),
      policy,
      generatedCount: 0,
      mode: "agent",
    });
    expect(suite.regressionCount).toBe(0);
    expect(suite.perturbationCount).toBe(0);
    expect(suite.scenarios.every((s) => s.driver === "agent")).toBe(true);
  });
});
