import { describe, expect, it } from "vitest";
import { ScriptedLLM } from "../src/lib/agent/scripted.js";
import type { CompletionResult, LLM } from "../src/lib/agent/llm.js";
import { ManualClock } from "../src/lib/core/clock.js";
import { rupees } from "../src/lib/core/money.js";
import { HAMPERHUB } from "../src/lib/core/entities.js";
import { resolveDbConfig, redactUrl } from "../src/lib/db/config.js";
import { MutationSet } from "../src/lib/hamperhub/mutations.js";
import { computeSuiteMetrics } from "../src/lib/report/metrics.js";
import {
  auditNarrative,
  collectFailureFacts,
  explainFailure,
  renderDeterministicExplanation,
} from "../src/lib/report/explain.js";
import { PerturbingToolCaller } from "../src/lib/runner/perturbation.js";
import { runConcurrentBuyers } from "../src/lib/runner/concurrent.js";
import { runScenario, runSuite } from "../src/lib/runner/run.js";
import { PERTURBATION_SCENARIOS } from "../src/lib/scenarios/perturbations.js";
import { REGRESSION_SCENARIOS, scenarioById } from "../src/lib/scenarios/regression.js";
import { assembleSuite } from "../src/lib/scenarios/index.js";
import { loadPolicyFromFile } from "../src/lib/policy/load.js";
import type { ToolCaller, ToolResult } from "../src/lib/guard/guard.js";
import type { ToolName } from "../src/lib/hamperhub/tools.js";

// ---------------------------------------------------------------------------
// §14 database configuration
// ---------------------------------------------------------------------------

describe("database configuration", () => {
  it("is absent when nothing is configured", () => {
    expect(resolveDbConfig({})).toBeNull();
  });

  it("prefers an explicit DATABASE_URL", () => {
    const config = resolveDbConfig({
      DATABASE_URL: "postgres://u:p@db.example:5432/agentproof",
    });
    expect(config?.connectionString).toContain("db.example");
  });

  it("builds a URL from discrete PG variables", () => {
    const config = resolveDbConfig({
      PGHOST: "localhost",
      PGUSER: "postgres",
      PGPASSWORD: "password",
      PGDATABASE: "agentproof",
    });
    expect(config?.connectionString).toBe(
      "postgres://postgres:password@localhost:5432/agentproof",
    );
  });

  it("treats a path-like host as a Unix socket", () => {
    const config = resolveDbConfig({
      PGHOST: "/var/run/postgresql",
      PGPASSWORD: "password",
    });
    // The socket path belongs in the query string, not the authority.
    expect(config?.connectionString).toBe(
      "postgres://postgres:password@/agentproof?host=/var/run/postgresql",
    );
  });

  it("needs a host before it assumes a database exists", () => {
    // Defaulting the host would silently probe localhost in CI.
    expect(resolveDbConfig({ PGUSER: "postgres" })).toBeNull();
  });

  it("never exposes the password in the described form", () => {
    const config = resolveDbConfig({
      DATABASE_URL: "postgres://postgres:supersecret@localhost:5432/agentproof",
    });
    expect(config?.describe).not.toContain("supersecret");
    expect(redactUrl("postgres://u:pw@h/db")).toBe("postgres://u:****@h/db");
  });
});

// ---------------------------------------------------------------------------
// §15 entities
// ---------------------------------------------------------------------------

describe("spec entities", () => {
  it("names the demonstration merchant", () => {
    expect(HAMPERHUB.id).toBe("hamperhub");
    expect(HAMPERHUB.currency).toBe("INR");
  });
});

// ---------------------------------------------------------------------------
// §7C transport perturbations
// ---------------------------------------------------------------------------

function recordingCaller(): {
  caller: ToolCaller;
  calls: Array<{ name: ToolName; args: unknown }>;
} {
  const calls: Array<{ name: ToolName; args: unknown }> = [];
  return {
    calls,
    caller: {
      async callTool(name, args): Promise<ToolResult> {
        calls.push({ name, args });
        return { ok: true, data: { called: name } };
      },
    },
  };
}

describe("transport perturbations", () => {
  it("passes calls through untouched with an empty plan", async () => {
    const { caller, calls } = recordingCaller();
    const wrapper = new PerturbingToolCaller(caller, {});
    await wrapper.callTool("create_quote", { bundle_id: "b1" });
    expect(calls).toHaveLength(1);
    expect(wrapper.applied()).toHaveLength(0);
  });

  it("advances the clock before a delayed tool", async () => {
    const { caller } = recordingCaller();
    const clock = new ManualClock(new Date("2026-03-01T10:00:00Z"));
    const wrapper = new PerturbingToolCaller(
      caller,
      { delay: { tool: "create_checkout", advanceClockMinutes: 15 } },
      clock,
    );

    await wrapper.callTool("create_quote", {});
    expect(clock.now().toISOString()).toBe("2026-03-01T10:00:00.000Z");

    await wrapper.callTool("create_checkout", {});
    expect(clock.now().toISOString()).toBe("2026-03-01T10:15:00.000Z");
    expect(wrapper.applied()[0]?.kind).toBe("delay");
  });

  it("delivers a duplicate without the caller seeing it", async () => {
    const { caller, calls } = recordingCaller();
    const wrapper = new PerturbingToolCaller(caller, {
      duplicate: { tool: "create_checkout" },
    });

    const result = await wrapper.callTool("create_checkout", { quote_id: "q1" });

    // Executed twice downstream, one result returned upstream.
    expect(calls).toHaveLength(2);
    expect(result.ok).toBe(true);
    expect(wrapper.applied()[0]?.kind).toBe("duplicate");
  });

  it("only duplicates the requested occurrence", async () => {
    const { caller, calls } = recordingCaller();
    const wrapper = new PerturbingToolCaller(caller, {
      duplicate: { tool: "create_checkout", occurrence: 2 },
    });
    await wrapper.callTool("create_checkout", {});
    expect(calls).toHaveLength(1);
    await wrapper.callTool("create_checkout", {});
    expect(calls).toHaveLength(3);
  });

  it("replays an earlier call verbatim, once", async () => {
    const { caller, calls } = recordingCaller();
    const wrapper = new PerturbingToolCaller(caller, {
      replay: { replay: "approve_quote", after: "create_checkout" },
    });

    await wrapper.callTool("approve_quote", { quote_id: "q1", amount: 1399 });
    await wrapper.callTool("create_checkout", { quote_id: "q1" });

    expect(calls.map((c) => c.name)).toEqual([
      "approve_quote",
      "create_checkout",
      "approve_quote",
    ]);
    expect(calls[2]?.args).toEqual({ quote_id: "q1", amount: 1399 });

    // A second trigger must not replay again.
    await wrapper.callTool("create_checkout", { quote_id: "q1" });
    expect(calls.filter((c) => c.name === "approve_quote")).toHaveLength(2);
  });

  it("does nothing when the call to replay never happened", async () => {
    const { caller, calls } = recordingCaller();
    const wrapper = new PerturbingToolCaller(caller, {
      replay: { replay: "approve_quote", after: "create_checkout" },
    });
    await wrapper.callTool("create_checkout", {});
    expect(calls).toHaveLength(1);
  });
});

describe("perturbation scenarios", () => {
  it("expires a quote by delaying checkout", async () => {
    const result = await runScenario(
      scenarioById("pert-01-delayed-response") ?? PERTURBATION_SCENARIOS[0]!,
      { mutations: MutationSet.fixed() },
    );
    expect(result.firedInvariants).toContain("INV-QUOTE-EXPIRY");
    // The merchant catches its own expiry, so this is a safe rejection.
    expect(result.disposition).toBe("safely_rejected");
    expect(result.providerOrders).toBe(0);
    expect(result.perturbations.length).toBeGreaterThan(0);
  });

  it("catches a duplicated checkout delivery on a vulnerable integration", async () => {
    const scenario = PERTURBATION_SCENARIOS.find(
      (s) => s.id === "pert-02-duplicated-delivery",
    )!;
    const vulnerable = await runScenario(scenario, {
      mutations: MutationSet.only("missing_idempotency"),
    });
    expect(vulnerable.firedInvariants).toContain("INV-IDEMPOTENCY");
    expect(vulnerable.duplicatePayableOrders).toBe(0);

    const fixed = await runScenario(scenario, { mutations: MutationSet.fixed() });
    expect(fixed.integrationDefects).toEqual([]);
  });

  it("never lets a perturbation create a duplicate payable order", async () => {
    for (const scenario of PERTURBATION_SCENARIOS) {
      for (const mutations of [MutationSet.fixed(), MutationSet.vulnerable()]) {
        const result = await runScenario(scenario, { mutations });
        expect(result.duplicatePayableOrders).toBe(0);
        expect(result.error).toBeNull();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// §17 metrics
// ---------------------------------------------------------------------------

describe("suite metrics", () => {
  it("reports coverage over the whole rule set", async () => {
    const suite = await runSuite(REGRESSION_SCENARIOS, {
      mutations: MutationSet.vulnerable(),
    });
    const m = suite.metrics;

    expect(m.scenariosExecuted).toBe(REGRESSION_SCENARIOS.length);
    expect(m.policyRulesTotal).toBe(12);
    expect(m.policyRulesExercised).toBeGreaterThan(0);
    expect(m.policyRulesExercised).toBeLessThanOrEqual(m.policyRulesTotal);
    expect(m.toolPathsCovered).toBeGreaterThan(1);
    expect(m.unsafeMoneyActionsEscaped).toBe(0);
  });

  it("counts only integration defects as critical, so it cannot contradict the headline", async () => {
    const suite = await runSuite(REGRESSION_SCENARIOS, {
      mutations: MutationSet.fixed(),
    });
    expect(suite.unsafeViolations).toBe(0);
    expect(suite.metrics.criticalViolations).toBe(0);
  });

  it("returns null medians rather than zero when nothing fired", () => {
    const metrics = computeSuiteMetrics([]);
    expect(metrics.medianMsToFirstViolation).toBeNull();
    expect(metrics.medianToolCallsToFirstViolation).toBeNull();
    expect(metrics.scenariosExecuted).toBe(0);
  });

  it("reports duplicate payment attempts it prevented", async () => {
    const suite = await runSuite(REGRESSION_SCENARIOS, {
      mutations: MutationSet.only("missing_idempotency"),
    });
    expect(suite.metrics.duplicatePaymentAttemptsPrevented).toBeGreaterThan(0);
    expect(suite.metrics.unsafeMoneyActionsEscaped).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §16 failure explanation
// ---------------------------------------------------------------------------

describe("failure explanation", () => {
  async function failingJourney() {
    const result = await runScenario(scenarioById("reg-09-discount-stacking")!, {
      mutations: MutationSet.only("discount_stacking"),
    });
    expect(result.disposition).toBe("unsafe_violation");
    return result;
  }

  it("produces a complete deterministic explanation with no model", async () => {
    const journey = await failingJourney();
    const explanation = await explainFailure(journey);

    expect(explanation.narrative).toBeNull();
    expect(explanation.deterministic).toContain("INV-DISCOUNT-CAP");
    expect(explanation.deterministic).toContain("attributed to integration");
    expect(explanation.deterministic).toContain("fix:");
  });

  it("ignores the scripted model rather than inventing prose", async () => {
    const journey = await failingJourney();
    const explanation = await explainFailure(journey, new ScriptedLLM());
    expect(explanation.narrative).toBeNull();
  });

  it("passes only verified facts to the narrator", async () => {
    const journey = await failingJourney();
    const facts = collectFailureFacts(journey);

    expect(facts.findings[0]?.invariantId).toBe("INV-DISCOUNT-CAP");
    expect(facts.moneyAtRisk).toMatch(/^₹/);
    // No raw catalog or state the model could do arithmetic on.
    expect(JSON.stringify(facts)).not.toContain("priceMinor");
    expect(renderDeterministicExplanation(facts)).toContain(journey.scenarioId);
  });

  it("accepts a narrative that only uses supplied figures", async () => {
    const facts = collectFailureFacts(await failingJourney());
    const check = auditNarrative(
      "The agent stacked promotions and the effective discount reached 8.7%, " +
        "above the 5% cap. Validate the cumulative discount instead.",
      facts,
    );
    expect(check.ok).toBe(true);
  });

  it("rejects a narrative that invents a figure", async () => {
    const facts = collectFailureFacts(await failingJourney());
    const check = auditNarrative(
      "The buyer was overcharged by ₹98765 because of stacked discounts.",
      facts,
    );
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toContain("98765");
  });

  it("withholds a fabricating narrative instead of publishing it", async () => {
    const journey = await failingJourney();
    const liar: LLM = {
      name: "liar",
      isReal: true,
      async complete(): Promise<CompletionResult> {
        return {
          content: JSON.stringify({
            explanation: "The discount reached 99.9% and cost ₹444444.",
          }),
          toolCalls: [],
          model: "liar",
        };
      },
    };

    const explanation = await explainFailure(journey, liar);
    expect(explanation.narrative).toBeNull();
    expect(explanation.model).toContain("rejected");
    // The deterministic account still stands.
    expect(explanation.deterministic).toContain("INV-DISCOUNT-CAP");
  });

  it("survives a narrator that throws", async () => {
    const journey = await failingJourney();
    const broken: LLM = {
      name: "broken",
      isReal: true,
      async complete(): Promise<CompletionResult> {
        throw new Error("narrator down");
      },
    };
    const explanation = await explainFailure(journey, broken);
    expect(explanation.narrative).toBeNull();
    expect(explanation.deterministic.length).toBeGreaterThan(0);
  });

  it("uses a well-behaved narrative when one is produced", async () => {
    const journey = await failingJourney();
    const good: LLM = {
      name: "good",
      isReal: true,
      async complete(): Promise<CompletionResult> {
        return {
          content: JSON.stringify({
            explanation:
              "The agent applied every promotion it could find. Validate the " +
              "cumulative effective discount rather than each component.",
          }),
          toolCalls: [],
          model: "good-model",
        };
      },
    };
    const explanation = await explainFailure(journey, good);
    expect(explanation.narrative).toContain("cumulative");
    expect(explanation.model).toBe("good-model");
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe("concurrent buyers", () => {
  it("never oversells contested stock", async () => {
    const result = await runConcurrentBuyers({ buyers: 5, stock: 3 });

    expect(result.ordersConfirmed).toBeLessThanOrEqual(result.openingStock);
    expect(result.oversold).toBe(false);
    expect(result.duplicatePayableOrders).toBe(0);
    expect(result.auditChainOk).toBe(true);
  });

  it("still lets winners through rather than starving everyone", async () => {
    // A Guard that blocked every buyer would never oversell, and would be useless.
    const result = await runConcurrentBuyers({ buyers: 4, stock: 2 });
    expect(result.ordersConfirmed).toBeGreaterThan(0);
    expect(result.ordersConfirmed).toBeLessThanOrEqual(2);
  });

  it("holds under contention on the vulnerable integration too", async () => {
    const result = await runConcurrentBuyers({
      buyers: 5,
      stock: 3,
      mutations: MutationSet.vulnerable(),
    });
    expect(result.oversold).toBe(false);
    expect(result.duplicatePayableOrders).toBe(0);
  });

  it("leaves no stock reserved once every buyer has settled", async () => {
    const result = await runConcurrentBuyers({ buyers: 4, stock: 2 });
    // Dangling reservations would silently make stock unsellable.
    expect(result.finalReserved).toBe(0);
  });

  it("keeps one shared audit chain intact across interleaved buyers", async () => {
    const result = await runConcurrentBuyers({ buyers: 5, stock: 3 });
    expect(result.auditEvents).toBeGreaterThan(20);
    expect(result.auditChainOk).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite composition
// ---------------------------------------------------------------------------

describe("assembled suite", () => {
  it("stays inside the spec's 20-25 journey range", async () => {
    const suite = await assembleSuite({
      llm: new ScriptedLLM(),
      policy: loadPolicyFromFile(),
    });
    expect(suite.scenarios.length).toBeGreaterThanOrEqual(20);
    expect(suite.scenarios.length).toBeLessThanOrEqual(25);
    expect(suite.perturbationCount).toBe(PERTURBATION_SCENARIOS.length);
  });

  it("covers all four scenario categories", async () => {
    const suite = await assembleSuite({
      llm: new ScriptedLLM(),
      policy: loadPolicyFromFile(),
    });
    const categories = new Set(suite.scenarios.map((s) => s.category));
    expect(categories).toContain("normal");
    expect(categories).toContain("boundary");
    expect(categories).toContain("adversarial");
    expect(categories).toContain("state_perturbation");
  });

  it("reports no integration defect on a fixed integration across the whole suite", async () => {
    const suite = await assembleSuite({
      llm: new ScriptedLLM(),
      policy: loadPolicyFromFile(),
    });
    const result = await runSuite(suite.scenarios, {
      mutations: MutationSet.fixed(),
    });
    expect(result.unsafeViolations).toBe(0);
    expect(result.moneyCriticalEscapes).toBe(0);
    expect(result.readiness).toBe("READY FOR CONTROLLED TEST");
    expect(rupees(1399)).toBe(139900);
  });
});
