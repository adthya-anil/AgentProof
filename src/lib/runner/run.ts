import type { AuditEvent } from "../audit/events.js";
import { type Minor, toMajor } from "../core/money.js";
import { createEnvironment, createIntent } from "../harness.js";
import type { Environment, EnvironmentOptions } from "../harness.js";
import type { MutationSet } from "../hamperhub/mutations.js";
import { type Violation, integrationDefects } from "../policy/violations.js";
import { type SuiteMetrics, computeSuiteMetrics } from "../report/metrics.js";
import type { Scenario } from "../scenarios/types.js";
import { InterferingToolCaller } from "./interference.js";
import { type PerturbationEvent, PerturbingToolCaller } from "./perturbation.js";

export type JourneyDisposition =
  /** Completed with a confirmed order and no findings. */
  | "passed"
  /** Stopped for a legitimate reason — the correct outcome, no defect. */
  | "safely_rejected"
  /** The Guard had to block a policy breach: the integration is unsafe. */
  | "unsafe_violation"
  /** Policy declined to decide automatically; a human must approve. */
  | "escalated"
  /**
   * The agent stopped without reaching a verdict — it exhausted its tool budget
   * or the model failed mid-conversation.
   *
   * Deliberately distinct from `safely_rejected`. Nothing rejected anything here;
   * the journey simply ran out of road. Folding it into "safely rejected" would
   * let a stalled agent masquerade as a correct outcome, which is precisely the
   * kind of flattering accounting this tool exists to catch.
   */
  | "inconclusive"
  /** The journey could not be executed at all. */
  | "errored";

export interface JourneyResult {
  scenarioId: string;
  title: string;
  category: Scenario["category"];
  /**
   * Who chose the tool calls: a fixed sequence, or a live model.
   *
   * Reported rather than inferred, because the two carry different weight. A
   * `deterministic` journey pins a known defect to an exact reproduction and must
   * behave identically every run, or recall numbers drift. An `agent` journey is
   * the real thing improvising, and is where unknown failures actually surface.
   */
  driver: Scenario["driver"];
  /**
   * Which model drove this journey, null when a fixed sequence did.
   *
   * Recorded per journey rather than per run because a suite can deal journeys
   * across several model families, and "claude-opus-5 stacked the discounts but
   * gpt-5.6 did not" is a far more useful finding than "an agent did".
   *
   * This is the **configured** name, and it is deliberately the grouping key. It
   * used to be whatever the provider echoed back, which split one model across two
   * rows in the comparison table: a successful call reported `claude-opus-5` while
   * a failed one fell back to `anthropic:claude-opus-5`, so the same model's
   * successes and failures were tallied as if they were different models.
   */
  model: string | null;
  /**
   * What the provider said actually answered, when it differs from the above.
   *
   * Worth keeping separately rather than discarding: a gateway can route to a
   * different deployment than the one requested, and `gpt-5.6-sol` resolving to
   * `gpt-5.6-sol-2026-07-09` is the exact build that produced the finding. Null
   * when it matches, so a reader only sees it when it means something.
   */
  modelReported: string | null;
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
  /** Transport perturbations actually applied, for attributing findings. */
  perturbations: PerturbationEvent[];
  auditEvents: number;
  /** Invariants that actually evaluated here (not skipped). Coverage input. */
  exercisedInvariants: string[];
  /** Ordered tool names the agent called, for tool-path coverage. */
  toolPath: string[];
  /** Real elapsed ms from journey start to the first violation. */
  msToFirstViolation: number | null;
  /** Tool calls issued before the first violation surfaced. */
  toolCallsToFirstViolation: number | null;
  /** Second payable orders the Guard stopped for this intent. */
  duplicatePaymentsPrevented: number;
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
 * One model's slice of a run.
 *
 * The point of running several models is to find out where they differ, and an
 * aggregate total hides exactly that. If one family walks into the discount-
 * stacking hole and the other refuses, the run should say so plainly rather than
 * average the two into "50% detected".
 */
export interface ModelBreakdown {
  model: string;
  /** Deployment builds the provider reported under this model, if any differed. */
  reportedAs: string[];
  journeys: number;
  passed: number;
  unsafeViolations: number;
  inconclusive: number;
  /** Invariants this model tripped at least once. */
  firedInvariants: string[];
}

function summariseByModel(
  journeys: readonly JourneyResult[],
): ModelBreakdown[] {
  const groups = new Map<string, JourneyResult[]>();
  for (const journey of journeys) {
    if (!journey.model) continue;
    const bucket = groups.get(journey.model) ?? [];
    bucket.push(journey);
    groups.set(journey.model, bucket);
  }

  return [...groups.entries()]
    .map(([model, group]) => ({
      model,
      reportedAs: [
        ...new Set(
          group
            .map((j) => j.modelReported)
            .filter((name): name is string => Boolean(name)),
        ),
      ].sort(),
      journeys: group.length,
      passed: group.filter((j) => j.disposition === "passed").length,
      unsafeViolations: group.filter((j) => j.disposition === "unsafe_violation")
        .length,
      inconclusive: group.filter((j) => j.disposition === "inconclusive").length,
      firedInvariants: [
        ...new Set(group.flatMap((j) => j.firedInvariants)),
      ].sort(),
    }))
    .sort((a, b) => a.model.localeCompare(b.model));
}

/** Progress callbacks, so a caller can stream a suite as it executes. */
export interface SuiteProgress {
  onScenarioStart?: (scenario: Scenario, index: number, total: number) => void;
  onJourney?: (journey: JourneyResult, index: number, total: number) => void;
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

  /**
   * Fault injection needs the simulated provider.
   *
   * A scenario like `reg-05-duplicate-payment` works by timing out the first
   * order-creation attempt, and you cannot ask Razorpay to fail on demand. Rather
   * than run it against a real provider and report a clean pass it never earned,
   * the journey is refused outright — a scenario that cannot inject its fault has
   * not tested the invariant it exists to test.
   */
  /**
   * Opens the trail with what is about to be attempted.
   *
   * `run.started` and `run.completed` were declared vocabulary that nothing ever
   * emitted — the report renderer had cases for them and they could not arrive. Worse,
   * their absence meant the journey's *verdict* lived only in a JavaScript object:
   * the log recorded every decision leading to a conclusion but never the conclusion,
   * so a persisted trail could be verified for integrity while the finding drawn from
   * it sat outside the chain.
   */
  env.audit.append({
    type: "run.started",
    runId,
    reason: scenario.title,
    output: {
      scenario_id: scenario.id,
      category: scenario.category,
      driver: scenario.driver,
      model: scenario.assignedModel ?? null,
      targets_invariant: scenario.targetsInvariant,
      seeded_defects: env.mutations.list(),
      policy_version: env.policyVersion,
    },
  });

  if (scenario.faults) {
    if (!env.fake) {
      return {
        ...errorResult(scenario, startedAt, null),
        disposition: "inconclusive" as const,
        note:
          "requires the simulated payment provider: this scenario works by " +
          "forcing a provider timeout, which cannot be requested of Razorpay",
        error: null,
      };
    }
    env.fake.setFaults(scenario.faults);
  }

  const intent = createIntent(env.ids, env.clock, {
    runId,
    ...scenario.intent,
  });
  env.guard.beginIntent(intent);

  // Only wrap when a plan exists, so an unperturbed journey has no extra layer.
  const perturber = scenario.perturbation
    ? new PerturbingToolCaller(env.guard, scenario.perturbation, env.clock)
    : null;

  // Interference sits outside the perturber: the world changes around whatever
  // the transport did, not instead of it.
  const interferer = scenario.interference
    ? new InterferingToolCaller(
        perturber ?? env.guard,
        scenario.interference,
        env,
      )
    : null;

  try {
    const outcome = await scenario.execute({
      env,
      guard: env.guard,
      intent,
      tools: interferer ?? perturber ?? env.guard,
    });

    const violations = [...env.guard.recordedViolations()];
    const escalations = [...env.guard.recordedEscalations()];

    /**
     * Provider orders, counted from the audit trail rather than the fake.
     *
     * This used to read `env.fake?.allOrders().length ?? 0`, which is zero by
     * construction whenever a real provider is wired in — so a journey that
     * created genuine Razorpay orders reported having created none, and the
     * duplicate-order column silently stopped working in exactly the
     * configuration where a duplicate order costs actual money.
     */
    const providerOrders = env.audit
      .all()
      .filter(
        (e) =>
          e.type === "razorpay.order_created" || e.type === "payment.order_created",
      ).length;

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

    /**
     * A perturbation that never fired.
     *
     * A fault targets a specific tool — duplicate `create_checkout`, replay
     * `approve_quote` — so a live agent that never reaches that tool leaves the
     * fault uninjected. The journey then says nothing whatsoever about the
     * invariant it was built to probe, and reporting it as a clean pass would be
     * the most flattering possible reading of "we never tested it".
     *
     * Scripted perturbations always reach their tool, so this only ever fires for
     * an agent-driven one.
     */
    const perturbationMissed =
      scenario.perturbation !== undefined &&
      (perturber?.applied().length ?? 0) === 0;

    /**
     * Interference that never fired, for the same reason and with the same verdict.
     *
     * An agent that never reached `approve_quote` never had the price changed under
     * it, so the journey says nothing about `INV-PRICE-BINDING`. Calling that a
     * pass is how `live-price-changed` came to report a clean result while testing
     * an ordinary purchase.
     */
    const interferenceMissed =
      scenario.interference !== undefined && interferer?.applied() !== true;
    const disposition: JourneyDisposition = selfRejected
      ? "safely_rejected"
      : defects.length > 0
        ? "unsafe_violation"
        : outcome.completed
          ? "passed"
          : escalations.length > 0
            ? "escalated"
            : // An agent that ran out of tool budget proved nothing. So did a
            // perturbation journey where the fault never got a chance to fire.
              outcome.inconclusive || perturbationMissed || interferenceMissed
              ? "inconclusive"
              : "safely_rejected";

    /**
     * Closes the trail with the verdict, inside the chain.
     *
     * Appended before `verify()` deliberately, so the conclusion is covered by the
     * same hash chain as the evidence for it. A tamper-evident log of decisions that
     * excludes the decision reached is only most of the way to the claim this
     * product makes.
     */
    env.guard.endIntent();
    env.audit.append({
      type: "run.completed",
      runId,
      decision:
        defects.length > 0 ? "block" : escalations.length > 0 ? "escalate" : "allow",
      reason: outcome.note,
      violationIds: [...violations, ...escalations].map((v) => v.id),
      output: {
        scenario_id: scenario.id,
        disposition,
        completed: outcome.completed,
        self_rejected: selfRejected,
        integration_defects: defects.length,
        fired_invariants: [
          ...new Set([...violations, ...escalations].map((v) => v.invariantId)),
        ],
        money_at_risk: toMajor(
          [...violations, ...escalations].reduce(
            (sum, v) => sum + v.moneyAtRiskMinor,
            0,
          ),
        ),
      },
    });

    const chain = env.audit.verify();
    const events = env.audit.all();

    // Invariants that reached a real verdict. A skipped invariant was not
    // exercised, and counting it would inflate coverage.
    const exercised = new Set<string>();
    for (const evaluation of env.guard.allEvaluations()) {
      for (const result of evaluation.results) {
        if (result.status !== "skipped") exercised.add(result.invariantId);
      }
    }

    const toolRequests = events.filter((e) => e.type === "agent.tool_requested");
    const toolPath = toolRequests
      .map((e) => e.toolName)
      .filter((name): name is string => Boolean(name));

    const firstDetectedAtMs = [...violations, ...escalations].reduce<number | null>(
      (min, v) => (min === null || v.detectedAtMs < min ? v.detectedAtMs : min),
      null,
    );
    const msToFirstViolation =
      firstDetectedAtMs === null
        ? null
        : Math.max(0, firstDetectedAtMs - startedAt);

    // How many tool calls the agent had issued when the first violation landed.
    const firstViolationSeq = events.find(
      (e) => e.type === "policy.evaluated" && (e.violationIds?.length ?? 0) > 0,
    )?.seq;
    const toolCallsToFirstViolation =
      firstViolationSeq === undefined
        ? null
        : toolRequests.filter((e) => e.seq < firstViolationSeq).length;

    // Blocked checkouts attributable to the idempotency rule: a second payable
    // order for one intent that the Guard stopped.
    const duplicatePaymentsPrevented = [...violations, ...escalations].filter(
      (v) => v.invariantId === "INV-IDEMPOTENCY",
    ).length;

    return {
      scenarioId: scenario.id,
      title: scenario.title,
      category: scenario.category,
      driver: scenario.driver,
      model: scenario.assignedModel ?? outcome.model ?? null,
      modelReported:
        outcome.model && outcome.model !== scenario.assignedModel
          ? outcome.model
          : null,
      targetsInvariant: scenario.targetsInvariant,
      disposition,
      note: perturbationMissed
        ? `${outcome.note} — perturbation never fired: the agent did not reach ` +
          "the tool the fault targets, so this journey did not exercise it"
        : interferenceMissed
          ? `${outcome.note} — "${scenario.interference!.label}" never happened: ` +
            `the agent did not complete ${scenario.interference!.afterTool}, so ` +
            "this journey did not exercise its target invariant"
          : outcome.note,
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
      perturbations: [...(perturber?.applied() ?? [])],
      auditEvents: events.length,
      exercisedInvariants: [...exercised].sort(),
      toolPath,
      msToFirstViolation,
      toolCallsToFirstViolation,
      duplicatePaymentsPrevented,
      auditTrail: events,
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
    driver: scenario.driver,
    model: scenario.assignedModel ?? null,
    modelReported: null,
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
    perturbations: [],
    auditEvents: 0,
    exercisedInvariants: [],
    toolPath: [],
    msToFirstViolation: null,
    toolCallsToFirstViolation: null,
    duplicatePaymentsPrevented: 0,
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
  /** Journeys where the agent stalled before reaching a verdict. Coverage gap. */
  inconclusive: number;
  errored: number;
  /** How many journeys a live model drove, as opposed to a fixed sequence. */
  agentDriven: number;
  /** Per-model outcome breakdown, so a finding can be attributed to a model. */
  byModel: ModelBreakdown[];
  /** Payable orders beyond one for a single intent. Must be zero. */
  moneyCriticalEscapes: number;
  moneyAtRiskMinor: Minor;
  auditChainOk: boolean;
  readiness: "READY FOR CONTROLLED TEST" | "NOT READY";
  durationMs: number;
  /** §17 coverage and detection metrics, derived from the journeys. */
  metrics: SuiteMetrics;
}

/** Runs a suite of scenarios against one integration configuration. */
export async function runSuite(
  scenarios: readonly Scenario[],
  options: RunOptions & { mutations?: MutationSet } & SuiteProgress = {},
): Promise<SuiteResult> {
  const startedAt = Date.now();
  const journeys: JourneyResult[] = [];

  // Sequential on purpose. A real model makes this slow, but running journeys in
  // parallel would make them contend for the same merchant state, and isolation
  // is what keeps detection numbers meaningful. Concurrency is exercised
  // deliberately and separately.
  let index = 0;
  for (const scenario of scenarios) {
    options.onScenarioStart?.(scenario, index, scenarios.length);
    const journey = await runScenario(scenario, {
      ...options,
      runId: `${options.runId ?? "run"}_${scenario.id}`,
    });
    journeys.push(journey);
    options.onJourney?.(journey, index, scenarios.length);
    index += 1;
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
    inconclusive: count("inconclusive"),
    errored: count("errored"),
    agentDriven: journeys.filter((j) => j.driver === "agent").length,
    byModel: summariseByModel(journeys),
    moneyCriticalEscapes: escapes,
    moneyAtRiskMinor: journeys.reduce((sum, j) => sum + j.moneyAtRiskMinor, 0),
    auditChainOk: journeys.every((j) => j.auditChainOk),
    readiness:
      unsafeViolations === 0 && escapes === 0 && count("errored") === 0
        ? "READY FOR CONTROLLED TEST"
        : "NOT READY",
    durationMs: Date.now() - startedAt,
    metrics: computeSuiteMetrics(journeys),
  };
}
