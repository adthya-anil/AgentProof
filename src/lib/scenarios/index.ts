import type { LLM } from "../agent/llm.js";
import type { Policy } from "../policy/schema.js";
import { generateScenarios } from "./generate.js";
import { REGRESSION_SCENARIOS } from "./regression.js";
import type { Scenario } from "./types.js";

export interface SuiteCompositionOptions {
  llm: LLM;
  policy: Policy;
  /** How many AI-generated journeys to add on top of the regression suite. */
  generatedCount?: number;
  /** Invariants that failed previously, so generation can probe nearby. */
  priorFailures?: string[];
  maxToolCalls?: number;
}

export interface AssembledSuite {
  scenarios: Scenario[];
  regressionCount: number;
  generatedCount: number;
  /** Which model produced the generated half, for the report header. */
  generatorModel: string;
  generatorIsReal: boolean;
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
    count: options.generatedCount ?? 12,
    priorFailures: options.priorFailures ?? [],
    maxToolCalls: options.maxToolCalls ?? 12,
  });

  return {
    scenarios: [...REGRESSION_SCENARIOS, ...generated],
    regressionCount: REGRESSION_SCENARIOS.length,
    generatedCount: generated.length,
    generatorModel: options.llm.name,
    generatorIsReal: options.llm.isReal,
  };
}

export { REGRESSION_SCENARIOS, scenarioById } from "./regression.js";
export { generateScenarios, SCRIPTED_GENERATED } from "./generate.js";
export type { Scenario, ScenarioCategory, ScenarioOutcome } from "./types.js";
