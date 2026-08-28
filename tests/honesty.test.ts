import { afterEach, describe, expect, it, vi } from "vitest";
import { describeEngine } from "../src/lib/dashboard/data.js";
import { type CompletionResult, type LLM, LlmError } from "../src/lib/agent/llm.js";
import { createEnvironment } from "../src/lib/harness.js";
import { ScriptedLLM } from "../src/lib/agent/scripted.js";
import { MutationSet } from "../src/lib/hamperhub/mutations.js";
import { loadPolicyFromFile } from "../src/lib/policy/load.js";
import { runScenario, runSuite } from "../src/lib/runner/run.js";
import { agentDrivenScenarios } from "../src/lib/scenarios/agentDriven.js";
import { assembleSuite } from "../src/lib/scenarios/index.js";
import {
  PERTURBATION_SCENARIOS,
  perturbationScenarios,
} from "../src/lib/scenarios/perturbations.js";
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

describe("documented knobs actually do something", () => {
  /**
   * `AGENTPROOF_SEED` was documented in the README and `.env.example` as
   * controlling reproducible runs, and was read by nothing at all — every run used
   * the hard-coded default whatever the file said. A knob that does nothing is
   * worse than no knob in a project whose whole claim is that its reports mean
   * what they say.
   */
  const withSeed = (seed?: string) => {
    if (seed === undefined) delete process.env.AGENTPROOF_SEED;
    else process.env.AGENTPROOF_SEED = seed;
    return createEnvironment().ids.next("quote");
  };

  afterEach(() => {
    delete process.env.AGENTPROOF_SEED;
  });

  it("makes AGENTPROOF_SEED reproducible", () => {
    expect(withSeed("1337")).toBe(withSeed("1337"));
  });

  it("makes AGENTPROOF_SEED actually change the run", () => {
    expect(withSeed("1337")).not.toBe(withSeed("9999"));
  });

  it("falls back to a fixed default when the seed is blank", () => {
    // A bare `AGENTPROOF_SEED=` line must not become the literal seed "".
    expect(withSeed("")).toBe(withSeed(undefined));
  });

  it("lets an explicit option beat the environment", () => {
    process.env.AGENTPROOF_SEED = "from-env";
    const explicit = createEnvironment({ seed: "from-code" }).ids.next("quote");
    const fromEnv = createEnvironment().ids.next("quote");
    expect(explicit).not.toBe(fromEnv);
  });
});

describe("the engine panel reports the whole pool", () => {
  /**
   * `describeEngine` returned only the primary adapter, so a correctly configured
   * second model was invisible until a run was already underway — making the only
   * way to verify your configuration to spend tokens on it. The singular "Model"
   * label then read as confirmation that one model was all there should be.
   */
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("names every configured model", () => {
    vi.stubEnv("LLM_ADAPTER", "openai");
    vi.stubEnv("LLM_API_KEY", "k");
    vi.stubEnv("LLM_MODEL", "gpt-5.6-sol");
    vi.stubEnv("ANTHROPIC_MODEL", "claude-opus-5");

    expect(describeEngine().pool).toEqual([
      "openai:gpt-5.6-sol",
      "anthropic:claude-opus-5",
    ]);
  });

  it("reports an empty pool rather than inventing a model", () => {
    vi.stubEnv("LLM_ADAPTER", "scripted");
    vi.stubEnv("LLM_API_KEY", "");
    vi.stubEnv("ANTHROPIC_MODEL", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    expect(describeEngine().pool).toEqual([]);
  });

  it("never throws on a broken configuration, because it renders a page", () => {
    vi.stubEnv("LLM_ADAPTER", "nonsense-adapter");
    expect(() => describeEngine()).not.toThrow();
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
    // No real model, so there are no agent-driven perturbations to run — and the
    // scripted ones are not offered as a consolation prize.
    expect(suite.perturbationCount).toBe(0);
    expect(suite.scenarios.every((s) => s.driver === "agent")).toBe(true);
  });
});

describe("nothing is ever silently swapped for a script", () => {
  /** A real-looking model whose every call fails. */
  const brokenReal: LLM = {
    name: "openai:broken",
    isReal: true,
    async complete() {
      throw new LlmError("provider exploded", "provider", false);
    },
  };

  it("propagates a generation failure instead of assembling a scripted suite", async () => {
    await expect(
      assembleSuite({
        llm: brokenReal,
        policy: loadPolicyFromFile(),
        generatedCount: 3,
        mode: "both",
      }),
    ).rejects.toThrow(/provider exploded/);
  });

  it("drives perturbations with the real model, not a scripted strategy", () => {
    const scenarios = perturbationScenarios([
      { name: "openai:a", isReal: true, complete: brokenReal.complete },
    ]);
    expect(scenarios).toHaveLength(PERTURBATION_SCENARIOS.length);
    for (const scenario of scenarios) {
      expect(scenario.driver).toBe("agent");
      expect(scenario.assignedModel).toBe("openai:a");
      // The fault it targets is preserved — that is the whole point of §7C.
      expect(scenario.perturbation).toBeDefined();
    }
  });

  it("reports inconclusive when a perturbation never got to fire", async () => {
    // A model that stops immediately never reaches create_checkout, so the
    // duplicate-delivery fault is never injected and the journey proves nothing.
    const quitter: LLM = {
      name: "openai:quits",
      isReal: true,
      async complete() {
        return { content: "I would rather not.", toolCalls: [], model: "quits" };
      },
    };
    const scenario = perturbationScenarios([quitter]).find((s) =>
      s.id.startsWith("pert-02"),
    )!;

    const journey = await runScenario(scenario, {
      mutations: MutationSet.vulnerable(),
    });

    expect(journey.perturbations).toHaveLength(0);
    expect(journey.disposition).toBe("inconclusive");
    expect(journey.note).toMatch(/perturbation never fired/);
  });

  /**
   * A perturbation whose own buyer request stops the agent short is untestable.
   *
   * `pert-01` used to say "I'll think about it before confirming". The agent is
   * instructed never to self-approve without authorisation, so a real model
   * correctly halted at the quote and the `create_checkout` fault was never
   * injected — the scenario could not exercise the thing it existed to exercise.
   * The scripted driver masked it by forcing the steps.
   */
  it("never asks an agent to reach a tool the buyer forbade it from reaching", () => {
    const needsPurchase = /\b(go ahead|please buy|buy it|order|purchase|complete)\b/i;
    const refusesToCommit = /\b(think about it|before confirming|check back with me)\b/i;

    // Every fault here lands at or after approval, and approval is the step an
    // unauthorised agent refuses. So all four need explicit consent.
    const gated = new Set(["approve_quote", "create_checkout"]);

    for (const scenario of PERTURBATION_SCENARIOS) {
      const p = scenario.perturbation;
      const touchesGatedTool =
        (p?.delay?.tool !== undefined && gated.has(p.delay.tool)) ||
        (p?.duplicate?.tool !== undefined && gated.has(p.duplicate.tool)) ||
        (p?.replay?.replay !== undefined && gated.has(p.replay.replay)) ||
        (p?.replay?.after !== undefined && gated.has(p.replay.after));
      if (!touchesGatedTool) continue;

      const utterance = scenario.intent.utterance;
      expect(utterance, `${scenario.id} must authorise a purchase`).toMatch(
        needsPurchase,
      );
      expect(
        utterance,
        `${scenario.id} withholds consent, so checkout is unreachable`,
      ).not.toMatch(refusesToCommit);
    }
  });

  it("still fires the perturbation when the agent does reach the tool", async () => {
    // The scripted set always reaches its target, so it is the control case.
    const scenario = PERTURBATION_SCENARIOS.find((s) =>
      s.id.startsWith("pert-02"),
    )!;
    const journey = await runScenario(scenario, {
      mutations: MutationSet.vulnerable(),
    });
    expect(journey.perturbations.length).toBeGreaterThan(0);
    expect(journey.disposition).not.toBe("inconclusive");
  });
});
