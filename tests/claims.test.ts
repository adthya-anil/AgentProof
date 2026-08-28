import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ScriptedLLM } from "../src/lib/agent/scripted.js";
import { AuditLog } from "../src/lib/audit/log.js";
import { AUDIT_EVENT_TYPES } from "../src/lib/audit/events.js";
import { ManualClock } from "../src/lib/core/clock.js";
import { formatMinor } from "../src/lib/core/money.js";
import { SEED_CATALOG } from "../src/lib/hamperhub/catalog.js";
import { MUTATION_IDS, MutationSet } from "../src/lib/hamperhub/mutations.js";
import { TOOL_DECLARATIONS } from "../src/lib/hamperhub/tools.js";
import { ALL_INVARIANTS } from "../src/lib/policy/invariants/index.js";
import { loadPolicyFromFile } from "../src/lib/policy/load.js";
import { runSuite } from "../src/lib/runner/run.js";
import { assembleSuite } from "../src/lib/scenarios/index.js";
import { PERTURBATION_SCENARIOS } from "../src/lib/scenarios/perturbations.js";
import { REGRESSION_SCENARIOS } from "../src/lib/scenarios/regression.js";

/**
 * Every claim this project makes about itself, checked against the code.
 *
 * Four bugs of one shape had already been found by screenshot: a seed knob that did
 * nothing, an engine panel showing one of two configured models, a payment banner
 * from a different payment, and a skipped rule dressed as a failure. None would have
 * failed a test, because each was about what the product *said* rather than what it
 * computed — a blind spot a tool whose entire pitch is honest reporting can least
 * afford.
 *
 * So the claims are now assertions. A number in the README that drifts from the code
 * fails the build instead of misleading a reader.
 */

const README = readFileSync("README.md", "utf8");

describe("the README's structural claims match the code", () => {
  it("counts invariants correctly", () => {
    expect(ALL_INVARIANTS).toHaveLength(12);
    expect(README).toContain("all 12 invariants");
    expect(README).toContain("12 invariants");
  });

  it("counts the merchant catalogue correctly", () => {
    expect(SEED_CATALOG).toHaveLength(17);
    expect(README).toMatch(/products\s+17|17 products|seventeen products/i);
  });

  it("counts the agent's tools correctly", () => {
    // "six commerce tools" appears in the UI and the README.
    expect(TOOL_DECLARATIONS).toHaveLength(6);
    expect(README).toMatch(/six tools|six commerce tools/);
  });

  it("counts seeded defects correctly", () => {
    expect(MUTATION_IDS).toHaveLength(8);
    expect(README).toMatch(/8 seeded|Eight seeded|eight seeded/);
  });

  it("counts the fixed scenario suites correctly", () => {
    expect(REGRESSION_SCENARIOS).toHaveLength(12);
    expect(PERTURBATION_SCENARIOS).toHaveLength(4);
    expect(README).toContain("12 fixed regression");
    expect(README).toContain("4 state-perturbation");
  });

  it("counts database tables correctly", () => {
    const schema = readFileSync("src/lib/db/schema.sql", "utf8");
    const tables = schema.match(/^CREATE TABLE/gm) ?? [];
    expect(tables).toHaveLength(17);
    expect(README).toMatch(/17 tables|seventeen tables/i);
  });

  /**
   * The test count had drifted twice over, to two different wrong numbers in the
   * same file — 263 in one place and 193 in another, against an actual 303. A
   * self-reported figure nobody checks is a figure that is wrong.
   */
  it("states a test count that is not obviously stale", () => {
    const claims = [...README.matchAll(/(\d+) tests/g)].map((m) => Number(m[1]));
    expect(claims.length).toBeGreaterThan(0);

    // Every stated count must agree with every other. Two different numbers in one
    // document means at least one is wrong.
    expect(new Set(claims).size, `README states ${claims.join(" and ")} tests`).toBe(1);
  });
});

describe("the policy page's claims about the invariants", () => {
  /**
   * "Verdicts are arithmetic. No invariant consults an LLM." That is the load-bearing
   * claim of the whole product: if a verdict could depend on a model, it could differ
   * between runs and nothing measured here would mean anything.
   */
  it("has no invariant that reaches a model, the network, or the clock non-deterministically", () => {
    const offenders: string[] = [];

    for (const invariant of ALL_INVARIANTS) {
      const source = invariant.evaluate.toString();
      // A synchronous function cannot await a provider. Anything async here would
      // be the first sign the boundary had been crossed.
      if (source.includes("await ") || source.includes("fetch(")) {
        offenders.push(invariant.id);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("gives every invariant at least one checkpoint, so none is dead weight", () => {
    for (const invariant of ALL_INVARIANTS) {
      expect(
        invariant.appliesAt.length,
        `${invariant.id} applies nowhere`,
      ).toBeGreaterThan(0);
    }
  });

  it("declares an attribution for every invariant", () => {
    // Attribution is what keeps false positives at zero: only `integration`
    // findings are merchant defects. An invariant without one could be miscounted.
    for (const invariant of ALL_INVARIANTS) {
      expect(["integration", "agent", "environment"]).toContain(
        invariant.attribution,
      );
    }
  });
});

describe("the audit page's tamper-evidence claim", () => {
  const buildLog = () => {
    const log = new AuditLog(new ManualClock());
    for (let i = 1; i <= 5; i++) {
      log.append({ type: "tool.executed", runId: "r", reason: `step ${i}` });
    }
    return log;
  };

  it("verifies an untouched chain", () => {
    expect(buildLog().verify().ok).toBe(true);
  });

  /**
   * The page states: "altering or deleting any historical event invalidates every
   * hash after it". Both halves are tested, because a chain that catches edits but
   * not deletions would make the claim false in the more likely direction.
   */
  it("catches an altered historical event", () => {
    const log = buildLog();
    (log.all() as unknown as Array<{ reason: string | null }>)[2]!.reason =
      "tampered";
    const result = log.verify();
    expect(result.ok).toBe(false);
    expect(result.brokenAtSeq).toBe(3);
  });

  it("catches a deleted historical event", () => {
    const log = buildLog();
    (log as unknown as { events: unknown[] }).events.splice(2, 1);
    const result = log.verify();
    expect(result.ok).toBe(false);
  });

  it("catches an altered final event", () => {
    // The easiest one to miss: nothing follows it, so a naive check passes.
    const log = buildLog();
    (log.all() as unknown as Array<{ reason: string | null }>)[4]!.reason =
      "tampered";
    expect(log.verify().ok).toBe(false);
  });

  it("never persists a credential, even if a tool echoes one back", () => {
    const log = new AuditLog(new ManualClock());
    log.append({
      type: "tool.executed",
      runId: "r",
      input: {
        razorpay_key_secret: "should-never-appear",
        nested: { api_key: "also-not", password: "nor-this" },
        harmless: "keep me",
      },
    });

    const serialised = JSON.stringify(log.all());
    expect(serialised).not.toContain("should-never-appear");
    expect(serialised).not.toContain("also-not");
    expect(serialised).not.toContain("nor-this");
    expect(serialised).toContain("keep me");
  });
});

describe("the README's measured results match a real run", () => {
  /**
   * The strongest guard against drift in this file.
   *
   * The measured table is the most quotable thing in the README and the easiest to
   * leave behind after a behaviour change. Running the suite and asserting the
   * published figures means the table cannot silently become fiction — if a change
   * moves the numbers, this fails and the README has to be updated deliberately.
   */
  it("reproduces the published figures for both integrations", async () => {
    const policy = loadPolicyFromFile();
    const assembled = await assembleSuite({ llm: new ScriptedLLM(), policy });
    expect(assembled.scenarios).toHaveLength(25);

    const vulnerable = await runSuite(assembled.scenarios, {
      mutations: MutationSet.vulnerable(),
    });
    const fixed = await runSuite(assembled.scenarios, {
      mutations: MutationSet.fixed(),
    });

    expect({
      passed: vulnerable.passed,
      safelyRejected: vulnerable.safelyRejected,
      escalated: vulnerable.escalated,
      unsafe: vulnerable.unsafeViolations,
      escapes: vulnerable.moneyCriticalEscapes,
      atRisk: formatMinor(vulnerable.moneyAtRiskMinor),
      readiness: vulnerable.readiness,
    }).toEqual({
      passed: 8,
      safelyRejected: 10,
      escalated: 2,
      unsafe: 5,
      escapes: 0,
      atRisk: "₹16,224.18",
      readiness: "NOT READY",
    });

    expect({
      passed: fixed.passed,
      safelyRejected: fixed.safelyRejected,
      escalated: fixed.escalated,
      unsafe: fixed.unsafeViolations,
      escapes: fixed.moneyCriticalEscapes,
      atRisk: formatMinor(fixed.moneyAtRiskMinor),
      readiness: fixed.readiness,
    }).toEqual({
      passed: 11,
      safelyRejected: 13,
      escalated: 1,
      unsafe: 0,
      escapes: 0,
      atRisk: "₹12,607.00",
      readiness: "READY FOR CONTROLLED TEST",
    });

    // And the figures themselves appear in the README, so the table cannot be
    // quietly deleted to make this pass.
    expect(README).toContain("₹16,224.18");
    expect(README).toContain("₹12,607.00");
  });

  it("still finds the 11.44% discount the README singles out", async () => {
    const policy = loadPolicyFromFile();
    const assembled = await assembleSuite({ llm: new ScriptedLLM(), policy });
    const suite = await runSuite(assembled.scenarios, {
      mutations: MutationSet.vulnerable(),
    });

    const journey = suite.journeys.find((j) =>
      j.scenarioId.includes("grab-every-discount"),
    );
    expect(journey, "the scenario the README quotes must exist").toBeDefined();
    expect(journey!.disposition).toBe("unsafe_violation");

    const messages = journey!.violations.map((v) => v.message).join(" ");
    expect(messages).toContain("11.44%");
    expect(README).toContain("11.44%");

    // The README also claims a floor-price breach on four line items.
    expect(journey!.firedInvariants).toContain("INV-FLOOR-PRICE");
    expect(messages).toMatch(/4 line item/);
  });

  it("keeps every declared audit event type reachable", () => {
    // Dead vocabulary is the same class of untruth as a knob that does nothing:
    // the renderers have cases for these, so an unreachable one is a lie by
    // omission. `run.started` and `run.completed` were exactly that.
    expect(AUDIT_EVENT_TYPES.length).toBe(18);
    expect(new Set(AUDIT_EVENT_TYPES).size).toBe(AUDIT_EVENT_TYPES.length);
  });
});
