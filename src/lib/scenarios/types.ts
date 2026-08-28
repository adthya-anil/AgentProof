import type { BuyerIntent } from "../core/types.js";
import type { Guard, ToolCaller, ToolResult } from "../guard/guard.js";
import type { Environment } from "../harness.js";
import type { ToolName } from "../hamperhub/tools.js";
import type { FaultPlan } from "../payments/fake.js";
import type { PerturbationPlan } from "../runner/perturbation.js";

export type ScenarioCategory =
  | "normal"
  | "boundary"
  | "adversarial"
  | "state_perturbation";

export interface ScenarioContext {
  env: Environment;
  guard: Guard;
  intent: BuyerIntent;
  /**
   * What a buyer agent should call.
   *
   * Identical to `guard` unless the scenario declares a perturbation plan, in
   * which case this is the wrapper. Scenarios that drive an agent must use this
   * rather than `guard`, or the perturbation is silently skipped.
   */
  tools: ToolCaller;
}

export interface ScenarioOutcome {
  /** True when the journey reached a confirmed merchant order. */
  completed: boolean;
  note: string;
  /** The final tool result, used to tell a self-rejection from a Guard block. */
  lastResult?: ToolResult;
  /**
   * True when the journey ended without anything actually deciding it — the agent
   * burned its tool budget, or the model errored mid-conversation.
   *
   * Set this rather than letting the runner default to "safely rejected": a
   * stalled agent is a gap in the test, not evidence that the integration is safe.
   */
  inconclusive?: boolean;
  /**
   * The model that actually answered, as the provider reported it.
   *
   * Preferred over the assigned name because a gateway may route to a different
   * deployment than the one requested, and a report that names the wrong model is
   * worse than one that names none.
   */
  model?: string;
}

/**
 * Who picks the tool calls.
 *
 * `deterministic` scenarios replay a fixed sequence, because a regression test
 * for a known defect has to reproduce it identically on every run — otherwise
 * measured recall becomes a function of the model's mood. `agent` scenarios hand
 * the goal to a live model and let it improvise, which is where failures nobody
 * anticipated show up.
 */
export type ScenarioDriver = "deterministic" | "agent";

/** A change to the world, applied once, immediately after a given tool succeeds. */
export interface Interference {
  /** Fires after this tool returns successfully. */
  afterTool: ToolName;
  /** Shown in the journey note, so a reader knows what changed and when. */
  label: string;
  apply(env: Environment): void;
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
  /** Fixed sequence, or live model. Surfaced in every report. */
  driver: ScenarioDriver;
  /**
   * The model this journey will be handed to, when one is.
   *
   * Known before execution so a queued journey can already say who will drive it,
   * which matters when a suite spreads across two model families and takes
   * minutes. Null for deterministic scenarios.
   */
  assignedModel?: string | null;
  /**
   * The invariant this scenario is designed to exercise, when it has a specific
   * target. Used only for scoring — the Guard is never told about it, so a
   * scenario cannot cheat its way to a detection.
   */
  targetsInvariant: string | null;
  intent: ScenarioIntent;
  /** Provider faults to install before the journey runs. */
  faults?: FaultPlan;
  /**
   * The world changing underneath the agent, mid-journey.
   *
   * Declarative rather than written into `execute`, because a scripted body cannot
   * be shared with a live agent that chooses its own steps. When the price change
   * behind `INV-PRICE-BINDING` lived inside `reg-07`'s function, the live twin
   * inherited the invariant label and none of the mechanism — so it was an ordinary
   * purchase that passed while claiming to probe price binding.
   *
   * Keyed to a tool rather than to a position in a script, so the same declaration
   * works for a fixed sequence and for a model improvising around it.
   */
  interference?: Interference;
  /** Transport perturbations: latency, duplicate delivery, replay (§7C). */
  perturbation?: PerturbationPlan;
  execute(c: ScenarioContext): Promise<ScenarioOutcome>;
}
