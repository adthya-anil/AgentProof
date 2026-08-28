import type { LLM } from "../agent/llm.js";
import type { Policy } from "../policy/schema.js";
import { agentDrivenScenarios } from "./agentDriven.js";
import { generateScenarios } from "./generate.js";
import { EMPTY_INTEL, type GeneratorIntel } from "./intel.js";
import {
  PERTURBATION_SCENARIOS,
  perturbationScenarios,
} from "./perturbations.js";
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

/**
 * How to divide work between configured models.
 *
 * `compare` sends every model at the same goals as a buyer. That earned its place —
 * given one identical request, gpt-5.6-sol reached a 7.75% discount and tripped
 * INV-DISCOUNT-CAP while claude-opus-5 stacked four components to 14.23% and tripped
 * INV-FLOOR-PRICE as well. A single-model report finds the first hole and misses the
 * second.
 *
 * `split` gives them different jobs instead: one invents the attacks, another carries
 * them out. Cheaper, and it puts a model on the task nothing was doing — the
 * adversary had been generating blind.
 *
 * Neither is strictly better. Compare answers "does model choice change what happens
 * to my checkout?"; split answers "what can a model think up that I did not?".
 */
export type RoleMode = "compare" | "split";

export interface SuiteCompositionOptions {
  /** Model used to generate scenarios, and to drive them when no pool is given. */
  llm: LLM;
  /**
   * Model that invents the AI-generated goals, when it should not also be a buyer.
   *
   * Separated because designing an attack and executing one are different tasks, and
   * a second configured model duplicating the first as a buyer was work nobody asked
   * for.
   */
  adversary?: LLM;
  /** What the last run revealed, so generation aims rather than guesses. */
  intel?: GeneratorIntel;
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
  /** Who did what, so a report can say it rather than leave it inferred. */
  roles: { adversary: string; buyers: string[] };
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
  // The adversary writes the goals when one is designated; otherwise the primary
  // model does both jobs, as it did before roles existed.
  const generator = options.adversary ?? options.llm;

  const generated = await generateScenarios({
    llm: generator,
    policy: options.policy,
    // 12 regression + 4 perturbation + 9 generated = 25, the top of the
    // spec's 20-25 journey range.
    count: options.generatedCount ?? 9,
    intel: options.intel ?? EMPTY_INTEL,
    maxToolCalls: options.maxToolCalls ?? 24,
  });

  // Deterministic by default, so the documented suite stays inside the spec's
  // 20-25 journey range and a caller that asks for nothing gets a reproducible
  // run. The live-agent half roughly doubles the suite and takes minutes against
  // a real model, so it is opted into rather than inherited.
  const mode = options.mode ?? "deterministic";
  const pool =
    options.llms && options.llms.length > 0 ? options.llms : [options.llm];
  const realPool = pool.filter((llm) => llm.isReal);

  /**
   * Perturbations follow the mode, and are never substituted across it.
   *
   * `deterministic` gets the scripted set. A live mode gets the same faults driven
   * by real models with no strategy hint — a transport fault around a journey the
   * model actually chose.
   *
   * `agent` mode with no real model gets **nothing**. Handing back the scripted
   * set there would be precisely the silent substitution this refactor removes:
   * the caller asked for live agents, and four replayed scripts labelled
   * `deterministic` is not a smaller version of that, it is a different thing
   * wearing its name.
   */
  const perturbations =
    mode === "deterministic"
      ? PERTURBATION_SCENARIOS
      : realPool.length > 0
        ? perturbationScenarios(realPool)
        : [];

  const deterministic = mode === "agent" ? [] : REGRESSION_SCENARIOS;
  const live =
    mode === "deterministic"
      ? []
      : agentDrivenScenarios({
          llms: pool,
          maxToolCalls: options.maxToolCalls ?? 24,
          only: options.liveGoals,
        });

  return {
    scenarios: [...deterministic, ...perturbations, ...live, ...generated],
    regressionCount: deterministic.length,
    perturbationCount: perturbations.length,
    liveCount: live.length,
    generatedCount: generated.length,
    generatorModel: generator.name,
    generatorIsReal: generator.isReal,
    roles: {
      adversary: generator.name,
      buyers: [...new Set(pool.map((m) => m.name))],
    },
    driverModels: [
      ...new Set(
        [...perturbations, ...live, ...generated]
          .map((s) => s.assignedModel)
          .filter((name): name is string => Boolean(name)),
      ),
    ].sort(),
  };
}

export { REGRESSION_SCENARIOS, REGRESSION_GOALS, scenarioById } from "./regression.js";
export {
  PERTURBATION_SCENARIOS,
  perturbationScenarios,
} from "./perturbations.js";
export { agentDrivenScenarios } from "./agentDriven.js";
export { generateScenarios, SCRIPTED_GENERATED } from "./generate.js";
export type {
  Scenario,
  ScenarioCategory,
  ScenarioDriver,
  ScenarioOutcome,
} from "./types.js";
