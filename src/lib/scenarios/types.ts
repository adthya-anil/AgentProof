import type { BuyerIntent } from "../core/types.js";
import type { Guard, ToolResult } from "../guard/guard.js";
import type { Environment } from "../harness.js";
import type { FaultPlan } from "../payments/fake.js";

export type ScenarioCategory =
  | "normal"
  | "boundary"
  | "adversarial"
  | "state_perturbation";

export interface ScenarioContext {
  env: Environment;
  guard: Guard;
  intent: BuyerIntent;
}

export interface ScenarioOutcome {
  /** True when the journey reached a confirmed merchant order. */
  completed: boolean;
  note: string;
  /** The final tool result, used to tell a self-rejection from a Guard block. */
  lastResult?: ToolResult;
}

export interface ScenarioIntent {
  utterance: string;
  maxBudget?: number;
  requireVegan?: boolean;
  mustAvoidAllergens?: string[];
  occasion?: string | null;
  themes?: string[];
}

export interface Scenario {
  id: string;
  title: string;
  category: ScenarioCategory;
  /**
   * The invariant this scenario is designed to exercise, when it has a specific
   * target. Used only for scoring — the Guard is never told about it, so a
   * scenario cannot cheat its way to a detection.
   */
  targetsInvariant: string | null;
  intent: ScenarioIntent;
  /** Provider faults to install before the journey runs. */
  faults?: FaultPlan;
  execute(c: ScenarioContext): Promise<ScenarioOutcome>;
}
