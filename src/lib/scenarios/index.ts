import type { LLM } from "../agent/llm.js";
import type { Policy } from "../policy/schema.js";
import { agentDrivenScenarios } from "./agentDriven.js";
import { generateScenarios } from "./generate.js";
import { PERTURBATION_SCENARIOS } from "./perturbations.js";
import { REGRESSION_SCENARIOS } from "./regression.js";
import type { Scenario } from "./types.js";

/**
 * Which halves of the suite to run.
 *
 * `deterministic` is the reproducible baseline and the only honest basis for a
 * recall number. `agent` is a live model improvising against the same goals,
 * which is what a merchant actually ships against. Neither substitutes for the
 * other, so `both` is the default.
 */
export type SuiteMode = "deterministic" | "agent" | "both";

export interface SuiteCompositionOptions {
  /** Model used to generate scenarios, and to drive them when no pool is given. */
  llm: LLM;
  /**
   * Models to drive the live-agent half with. Defaults to `[llm]`.
   *
   * Every goal is attempted by every model in the pool, so this multiplies the
   * live half rather than dividing it.
   */
  llms?: readonly LLM[];
  policy: Policy;
  /** How many AI-generated journeys to add on top of the regression suite. */
  generatedCount?: number;
  /** Invariants that failed previously, so generation can probe nearby. */
  priorFailures?: string[];
  maxToolCalls?: number;
  mode?: SuiteMode;
  /** Restrict the live-agent half to specific regression ids. */
  liveGoals?: readonly string[];
}

export interface AssembledSuite {
  scenarios: Scenario[];
  regressionCount: number;
  perturbationCount: number;
  /** Regression goals re-run by a live agent with no scripted steps. */
  liveCount: number;
  generatedCount: number;
  /** Which model produced the generated half, for the report header. */
  generatorModel: string;
  generatorIsReal: boolean;
  /** Every model that will drive a journey in this suite. */
  driverModels: string[];
}

/**
 * Composes the full preflight suite: fixed regression scenarios plus
 * AI-generated ones.
 *
 * Both halves matter and they do different jobs. The regression scenarios are
 * the deterministic baseline that pins a defect to an exact reproduction; the
 * generated ones explore semantic space a developer would not think to script.
 * Running the fixed half first means a report always contains a comparable
 * baseline even if generation produced nothing useful.
 */
export async function assembleSuite(
  options: SuiteCompositionOptions,
): Promise<AssembledSuite> {
  const generated = await generateScenarios({
    llm: options.llm,
    policy: options.policy,
    // 12 regression + 4 perturbation + 9 generated = 25, the top of the
    // spec's 20-25 journey range.
    count: options.generatedCount ?? 9,
    priorFailures: options.priorFailures ?? [],
    maxToolCalls: options.maxToolCalls ?? 24,
  });

  // Deterministic by default, so the documented suite stays inside the spec's
  // 20-25 journey range and a caller that asks for nothing gets a reproducible
  // run. The live-agent half roughly doubles the suite and takes minutes against
  // a real model, so it is opted into rather than inherited.
  const mode = options.mode ?? "deterministic";
  const deterministic =
    mode === "agent"
      ? []
      : [...REGRESSION_SCENARIOS, ...PERTURBATION_SCENARIOS];
  const live =
    mode === "deterministic"
      ? []
      : agentDrivenScenarios({
          llms:
            options.llms && options.llms.length > 0 ? options.llms : [options.llm],
          maxToolCalls: options.maxToolCalls ?? 24,
          only: options.liveGoals,
        });

  return {
    scenarios: [...deterministic, ...live, ...generated],
    regressionCount: mode === "agent" ? 0 : REGRESSION_SCENARIOS.length,
    perturbationCount: mode === "agent" ? 0 : PERTURBATION_SCENARIOS.length,
    liveCount: live.length,
    generatedCount: generated.length,
    generatorModel: options.llm.name,
    generatorIsReal: options.llm.isReal,
    driverModels: [
      ...new Set(
        [...live, ...generated]
          .map((s) => s.assignedModel)
          .filter((name): name is string => Boolean(name)),
      ),
    ].sort(),
  };
}

export { REGRESSION_SCENARIOS, REGRESSION_GOALS, scenarioById } from "./regression.js";
export { PERTURBATION_SCENARIOS } from "./perturbations.js";
export { agentDrivenScenarios } from "./agentDriven.js";
export { generateScenarios, SCRIPTED_GENERATED } from "./generate.js";
export type {
  Scenario,
  ScenarioCategory,
  ScenarioDriver,
  ScenarioOutcome,
} from "./types.js";
