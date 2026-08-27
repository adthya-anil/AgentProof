import type { AuditEvent } from "../audit/events.js";
import type { Minor } from "../core/money.js";
import { createEnvironment, createIntent } from "../harness.js";
import type { Environment, EnvironmentOptions } from "../harness.js";
import type { MutationSet } from "../hamperhub/mutations.js";
import { type Violation, integrationDefects } from "../policy/violations.js";
import type { Scenario } from "../scenarios/types.js";

export type JourneyDisposition =
  /** Completed with a confirmed order and no findings. */
  | "passed"
  /** Stopped for a legitimate reason — the correct outcome, no defect. */
  | "safely_rejected"
  /** The Guard had to block a policy breach: the integration is unsafe. */
  | "unsafe_violation"
  /** Policy declined to decide automatically; a human must approve. */
  | "escalated"
  /** The journey could not be executed at all. */
  | "errored";

export interface JourneyResult {
  scenarioId: string;
  title: string;
  category: Scenario["category"];
  targetsInvariant: string | null;
  disposition: JourneyDisposition;
  note: string;
  violations: Violation[];
  escalations: Violation[];
  /**
   * Violations that indicate a genuine defect in the integration under test.
   *
   * Empty when the merchant's own code rejected the operation, even if the Guard
   * raised findings — a concurring verdict confirms correct behaviour rather
   * than revealing a bug.
   */
  integrationDefects: Violation[];
  firedInvariants: string[];
  moneyAtRiskMinor: Minor;
  /** Provider orders created during this journey. */
  providerOrders: number;
  /** Payable orders beyond the first — a real double-charge escape. */
  duplicatePayableOrders: number;
  /** True when the merchant's own code caught the problem. */
  selfRejected: boolean;
  auditEvents: number;
  /**
   * Full event trail for this journey, so a report or dashboard can replay it
   * without re-executing the scenario. Kept in memory: a journey is ~20 events.
   */
  auditTrail: readonly AuditEvent[];
  auditChainOk: boolean;
  durationMs: number;
  error: string | null;
}

export interface RunOptions extends EnvironmentOptions {
  runId?: string;
}

/**
 * Executes one scenario in a freshly-built environment.
 *
 * Isolation is deliberate: a scenario that zeroes the coffee stock must not
 * change what the next scenario sees, or detection numbers become a function of
 * execution order.
 */
export async function runScenario(
  scenario: Scenario,
  options: RunOptions = {},
): Promise<JourneyResult> {
  const runId = options.runId ?? `run_${scenario.id}`;
  const startedAt = Date.now();

  let env: Environment;
  try {
    env = createEnvironment(options);
  } catch (error) {
    return errorResult(scenario, startedAt, error);
  }

  if (scenario.faults && env.fake) env.fake.setFaults(scenario.faults);

  const intent = createIntent(env.ids, env.clock, {
    runId,
    ...scenario.intent,
  });
  env.guard.beginIntent(intent);

  try {
    const outcome = await scenario.execute({ env, guard: env.guard, intent });

    const violations = [...env.guard.recordedViolations()];
    const escalations = [...env.guard.recordedEscalations()];
    const providerOrders = env.fake?.allOrders().length ?? 0;

    // Only orders the merchant actually recorded as payable count as duplicates;
    // an order the provider created behind a timeout is reconciled, not charged.
    const payable = env.service
      .listCheckoutIntents(intent.id)
      .filter((c) => c.status === "authorized" || c.status === "fulfilled");

    const selfRejected =
      outcome.lastResult !== undefined &&
      !outcome.lastResult.ok &&
      outcome.lastResult.decision === "rejected";

    /**
     * Classification, in priority order:
     *
     *  1. If the merchant's own code refused, the journey was safely rejected —
     *     even when the Guard concurs. A concurring verdict is confirmation, not
     *     a defect, and counting it as one would penalise correct integrations.
     *  2. Only findings attributed to the *integration* indicate a merchant bug.
     *     The Guard stopping an overspending agent, or a mid-flight stock-out,
     *     is the system working as intended.
     *  3. Escalations are safe outcomes that need a human, never defects.
     */
    // A self-rejection clears the integration of blame entirely, so the defect
    // list must agree with the disposition. Reporting a "defect" on a journey
    // classified as safely rejected would let the summary and the violation list
    // contradict each other.
    const defects = selfRejected ? [] : integrationDefects(violations);
    const disposition: JourneyDisposition = selfRejected
      ? "safely_rejected"
      : defects.length > 0
        ? "unsafe_violation"
        : outcome.completed
          ? "passed"
          : escalations.length > 0
            ? "escalated"
            : "safely_rejected";

    const chain = env.audit.verify();

    return {
      scenarioId: scenario.id,
      title: scenario.title,
      category: scenario.category,
      targetsInvariant: scenario.targetsInvariant,
      disposition,
      note: outcome.note,
      violations,
      escalations,
      integrationDefects: defects,
      firedInvariants: [
        ...new Set([...violations, ...escalations].map((v) => v.invariantId)),
      ],
      moneyAtRiskMinor: [...violations, ...escalations].reduce(
        (sum, v) => sum + v.moneyAtRiskMinor,
        0,
      ),
      providerOrders,
      duplicatePayableOrders: Math.max(0, payable.length - 1),
      selfRejected,
      auditEvents: env.audit.all().length,
      auditTrail: env.audit.all(),
      auditChainOk: chain.ok,
      durationMs: Date.now() - startedAt,
      error: null,
    };
  } catch (error) {
    return errorResult(scenario, startedAt, error);
  }
}

function errorResult(
  scenario: Scenario,
  startedAt: number,
  error: unknown,
): JourneyResult {
  return {
    scenarioId: scenario.id,
    title: scenario.title,
    category: scenario.category,
    targetsInvariant: scenario.targetsInvariant,
    disposition: "errored",
    note: "journey could not be executed",
    violations: [],
    escalations: [],
    integrationDefects: [],
    firedInvariants: [],
    moneyAtRiskMinor: 0,
    providerOrders: 0,
    duplicatePayableOrders: 0,
    selfRejected: false,
    auditEvents: 0,
    auditTrail: [],
    auditChainOk: true,
    durationMs: Date.now() - startedAt,
    error: error instanceof Error ? error.message : String(error),
  };
}

export interface SuiteResult {
  runId: string;
  policyVersion: string;
  mutations: string[];
  journeys: JourneyResult[];
  passed: number;
  safelyRejected: number;
  escalated: number;
  unsafeViolations: number;
  errored: number;
  /** Payable orders beyond one for a single intent. Must be zero. */
  moneyCriticalEscapes: number;
  moneyAtRiskMinor: Minor;
  auditChainOk: boolean;
  readiness: "READY FOR CONTROLLED TEST" | "NOT READY";
  durationMs: number;
}

/** Runs a suite of scenarios against one integration configuration. */
export async function runSuite(
  scenarios: readonly Scenario[],
  options: RunOptions & { mutations?: MutationSet } = {},
): Promise<SuiteResult> {
  const startedAt = Date.now();
  const journeys: JourneyResult[] = [];

  for (const scenario of scenarios) {
    journeys.push(
      await runScenario(scenario, {
        ...options,
        runId: `${options.runId ?? "run"}_${scenario.id}`,
      }),
    );
  }

  const count = (d: JourneyDisposition) =>
    journeys.filter((j) => j.disposition === d).length;

  const unsafeViolations = count("unsafe_violation");
  const escapes = journeys.reduce(
    (sum, j) => sum + j.duplicatePayableOrders,
    0,
  );

  // A probe environment, purely to report which policy and defects were in play.
  const probe = createEnvironment(options);

  return {
    runId: options.runId ?? "run",
    policyVersion: probe.policyVersion,
    mutations: (options.mutations ?? probe.mutations).list(),
    journeys,
    passed: count("passed"),
    safelyRejected: count("safely_rejected"),
    escalated: count("escalated"),
    unsafeViolations,
    errored: count("errored"),
    moneyCriticalEscapes: escapes,
    moneyAtRiskMinor: journeys.reduce((sum, j) => sum + j.moneyAtRiskMinor, 0),
    auditChainOk: journeys.every((j) => j.auditChainOk),
    readiness:
      unsafeViolations === 0 && escapes === 0 && count("errored") === 0
        ? "READY FOR CONTROLLED TEST"
        : "NOT READY",
    durationMs: Date.now() - startedAt,
  };
}
