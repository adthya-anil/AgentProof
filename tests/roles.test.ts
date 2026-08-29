import { describe, expect, it } from "vitest";
import { assignRoles } from "../src/lib/agent/factory.js";
import type { CompletionResult, LLM } from "../src/lib/agent/llm.js";
import { ScriptedLLM } from "../src/lib/agent/scripted.js";
import { MutationSet } from "../src/lib/hamperhub/mutations.js";
import { ALL_INVARIANTS } from "../src/lib/policy/invariants/index.js";
import { loadPolicyFromFile } from "../src/lib/policy/load.js";
import { runSuite } from "../src/lib/runner/run.js";
import { assembleSuite } from "../src/lib/scenarios/index.js";
import {
  describeIntel,
  EMPTY_INTEL,
  intelFrom,
} from "../src/lib/scenarios/intel.js";
import { REGRESSION_SCENARIOS } from "../src/lib/scenarios/regression.js";

/**
 * Two configured models doing two jobs, and an adversary that knows something.
 *
 * Both models were buyers attempting the same goals. That comparison earned its place
 * — one model reached a 7.75% discount where the other stacked four components to
 * 14.23% and breached the floor price too — but it was the *only* thing a second model
 * could do, so configuring one bought duplication rather than capability.
 *
 * Worse, the generator prompt had always accepted `priorFailures` and no caller ever
 * passed it. The model inventing adversarial journeys was working blind: no knowledge
 * of which rules the shop had already broken, which nothing had reached, or where it
 * had held up. It produced variety, not pressure.
 */

function named(name: string): LLM {
  const inner = new ScriptedLLM();
  return {
    name,
    isReal: false,
    async complete(request): Promise<CompletionResult> {
      return { ...(await inner.complete(request)), model: name };
    },
  };
}

describe("dividing work between models", () => {
  const a = named("openai:a");
  const b = named("anthropic:b");

  it("makes every model a buyer in compare mode", () => {
    const { adversary, buyers } = assignRoles([a, b], "compare");
    expect(adversary).toBeUndefined();
    expect(buyers.map((m) => m.name)).toEqual(["openai:a", "anthropic:b"]);
  });

  it("promotes the last model to adversary in split mode", () => {
    // The last, because it is the opt-in second one: adding a model should change
    // what the new model does, not silently reassign the one already in use.
    const { adversary, buyers } = assignRoles([a, b], "split");
    expect(adversary?.name).toBe("anthropic:b");
    expect(buyers.map((m) => m.name)).toEqual(["openai:a"]);
  });

  it("does not strand the only model as an adversary with nobody to shop", () => {
    // With one model there is nothing to divide, so split must behave like compare
    // rather than producing goals no agent will attempt.
    const { adversary, buyers } = assignRoles([a], "split");
    expect(adversary).toBeUndefined();
    expect(buyers).toHaveLength(1);
  });

  it("copes with no models at all", () => {
    expect(assignRoles([], "split")).toEqual({
      adversary: undefined,
      buyers: [],
    });
  });

  it("reports who held which role", async () => {
    const suite = await assembleSuite({
      llm: a,
      llms: [a],
      adversary: b,
      policy: loadPolicyFromFile(),
      generatedCount: 1,
    });

    // Stated, not inferred: a reader should never have to work out which model
    // wrote a scenario and which attempted it.
    expect(suite.roles.adversary).toBe("anthropic:b");
    expect(suite.roles.buyers).toEqual(["openai:a"]);
    expect(suite.generatorModel).toBe("anthropic:b");
  });

  it("does not name the adversary as a buyer when the pool contains it", async () => {
    /**
     * The bug this pins cost a real misreading. `roles.buyers` was the whole configured
     * pool, so a split run listed the adversary as a buyer alongside its actual job —
     * and beside a by-model table that reads exactly like the same goals being run twice,
     * which is the one thing the split exists to prevent.
     */
    const suite = await assembleSuite({
      llm: a,
      // The adversary is *in* the pool, which is the ordinary case: two configured models,
      // one promoted to write the goals.
      llms: [a, b],
      adversary: b,
      policy: loadPolicyFromFile(),
      generatedCount: 1,
    });

    expect(suite.roles.adversary).toBe("anthropic:b");
    expect(suite.roles.buyers).toEqual(["openai:a"]);
    expect(suite.roles.buyers).not.toContain("anthropic:b");
  });

  it("still names the single model a buyer when it does both jobs", async () => {
    /**
     * The case that makes the filter wrong if applied naively: with one model there is
     * nothing to subtract, and reporting no buyers at all would be worse than reporting
     * the truth, which is that it shops and writes.
     */
    const suite = await assembleSuite({
      llm: a,
      llms: [a],
      policy: loadPolicyFromFile(),
      generatedCount: 1,
    });
    expect(suite.roles.adversary).toBe("openai:a");
    expect(suite.roles.buyers).toEqual(["openai:a"]);
  });

  it("deals goals across buyers instead of repeating them", async () => {
    /**
     * The concern behind all of this: two models must not mean the same journey twice.
     * Round-robin *deals* — every goal is attempted once, by one model — so a two-buyer
     * pool produces the same number of journeys as one, split between them.
     */
    const one = await assembleSuite({
      mode: "agent",
      llm: a,
      llms: [a],
      policy: loadPolicyFromFile(),
      generatedCount: 0,
    });
    const two = await assembleSuite({
      mode: "agent",
      llm: a,
      llms: [a, b],
      policy: loadPolicyFromFile(),
      generatedCount: 0,
    });

    expect(two.scenarios.length).toBe(one.scenarios.length);
    const ids = two.scenarios.map((s) => s.id);
    expect(ids.length - new Set(ids).size).toBe(0);

    // And both buyers actually got work, rather than one taking everything.
    const drivers = new Set(
      two.scenarios.map((s) => s.assignedModel).filter(Boolean),
    );
    expect(drivers.size).toBe(2);
  });

  it("falls back to the primary model for generation when no adversary is set", async () => {
    const suite = await assembleSuite({
      llm: a,
      policy: loadPolicyFromFile(),
      generatedCount: 1,
    });
    expect(suite.roles.adversary).toBe("openai:a");
  });
});

describe("what the adversary is told about the last run", () => {
  it("reports nothing on a first run", () => {
    expect(describeIntel(EMPTY_INTEL)).toBe("");
  });

  it("names the rules the shop has already broken", async () => {
    const prior = await runSuite(REGRESSION_SCENARIOS, {
      mutations: MutationSet.vulnerable(),
    });
    const intel = intelFrom(prior);

    expect(intel.tripped).toContain("INV-DISCOUNT-CAP");
    expect(intel.tripped).toContain("INV-IDEMPOTENCY");

    const text = describeIntel(intel);
    expect(text).toContain("already broken");
    // The instruction matters as much as the list: a weak rule invites a harder
    // variant of the same idea, which is how 8.7% became 11.44%.
    expect(text).toMatch(/harder variants/i);
  });

  it("treats an unreached rule as a blind spot, not as safety", async () => {
    // A rule nothing exercised is the most valuable thing to aim at, and the easiest
    // to mistake for a clean result.
    //
    // Uses a journey that stops at the quote, because the happy path alone reaches
    // all twelve rules — which is itself worth knowing: a suite can look
    // comprehensive on coverage while consisting of one journey.
    const stopsEarly = REGRESSION_SCENARIOS.filter((s) =>
      s.id.startsWith("reg-03"),
    );
    const thin = await runSuite(stopsEarly, { mutations: MutationSet.fixed() });
    const intel = intelFrom(thin);

    expect(intel.neverExercised.length).toBeGreaterThan(0);
    const text = describeIntel(intel);
    expect(text).toMatch(/untested, not safe/i);
  });

  it("never invents a rule that does not exist", async () => {
    const prior = await runSuite(REGRESSION_SCENARIOS, {
      mutations: MutationSet.vulnerable(),
    });
    const intel = intelFrom(prior);
    const known = new Set(ALL_INVARIANTS.map((i) => i.id));

    for (const id of [...intel.tripped, ...intel.neverExercised]) {
      expect(known, `unknown invariant ${id}`).toContain(id);
    }
  });

  it("asks for escalation rather than repetition of what the shop survived", async () => {
    const prior = await runSuite(REGRESSION_SCENARIOS, {
      mutations: MutationSet.fixed(),
    });
    const intel = intelFrom(prior);

    expect(intel.survived.length).toBeGreaterThan(0);
    expect(describeIntel(intel)).toMatch(/Escalate rather than repeat/i);
  });

  it("caps the survivor list so the prompt stays a hint, not a transcript", async () => {
    const prior = await runSuite(REGRESSION_SCENARIOS, {
      mutations: MutationSet.fixed(),
    });
    expect(intelFrom(prior).survived.length).toBeLessThanOrEqual(8);
  });

  it("reaches the generator prompt", async () => {
    // The whole point. `priorFailures` was plumbed to exactly here and never
    // arrived, so this asserts the prompt actually carries the signal.
    let seen = "";
    const spy: LLM = {
      name: "spy",
      isReal: true,
      async complete(request) {
        seen = request.system;
        return {
          content: JSON.stringify({ scenarios: [] }),
          toolCalls: [],
          model: "spy",
        };
      },
    };

    const prior = await runSuite(REGRESSION_SCENARIOS, {
      mutations: MutationSet.vulnerable(),
    });

    await assembleSuite({
      llm: named("buyer"),
      llms: [named("buyer")],
      adversary: spy,
      policy: loadPolicyFromFile(),
      generatedCount: 2,
      intel: intelFrom(prior),
    }).catch(() => {
      // The spy returns no scenarios, which now throws rather than falling back to
      // a scripted set. The prompt is what is under test.
    });

    expect(seen).toContain("already broken");
    expect(seen).toContain("INV-DISCOUNT-CAP");
  });
});
