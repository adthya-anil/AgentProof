import type { SuiteResult } from "../runner/run.js";
import { ALL_INVARIANTS } from "../policy/invariants/index.js";

/**
 * What the adversary knows about the last run.
 *
 * The generator prompt has always accepted `priorFailures`, and nothing ever passed
 * it — every caller sent an empty array. So the model inventing adversarial journeys
 * was doing it blind, with no idea which rules had already been tripped, which had
 * never been reached, or where the shop had survived. It was generating variety, not
 * pressure.
 *
 * Three signals, because they suggest different attacks:
 *
 *  - `tripped` — the shop is demonstrably weak here, so a harder variant of the same
 *    idea is likely to find something worse. This is how 8.7% became 11.44%.
 *  - `neverExercised` — no journey has reached this rule at all. Not evidence of
 *    safety, evidence of a blind spot, and the most valuable thing to aim at.
 *  - `survived` — the shop handled these cleanly. Worth escalating rather than
 *    repeating.
 */
export interface GeneratorIntel {
  tripped: string[];
  neverExercised: string[];
  survived: string[];
}

export const EMPTY_INTEL: GeneratorIntel = Object.freeze({
  tripped: [],
  neverExercised: [],
  survived: [],
});

/**
 * Reads intel off a finished run.
 *
 * Deliberately derived from the run rather than accumulated over time: a suite is
 * the unit a developer reasons about, and stale signal from three policy versions ago
 * would send the adversary at rules that no longer behave that way.
 */
export function intelFrom(suite: SuiteResult): GeneratorIntel {
  const tripped = new Set<string>();
  const exercised = new Set<string>();
  const survived: string[] = [];

  for (const journey of suite.journeys) {
    for (const id of journey.firedInvariants) tripped.add(id);
    for (const id of journey.exercisedInvariants) exercised.add(id);
    // "Passed" means the shop completed a purchase with no finding — the case worth
    // pushing harder on, since a clean pass is where an escape would hide.
    if (journey.disposition === "passed") survived.push(journey.title);
  }

  return {
    tripped: [...tripped].sort(),
    neverExercised: ALL_INVARIANTS.map((i) => i.id)
      .filter((id) => !exercised.has(id))
      .sort(),
    // Capped: the prompt needs a hint, not a transcript.
    survived: survived.slice(0, 8),
  };
}

/** Renders intel for the generator prompt, or nothing on a first run. */
export function describeIntel(intel: GeneratorIntel): string {
  const parts: string[] = [];

  if (intel.tripped.length > 0) {
    parts.push(
      `Rules this integration has already broken: ${intel.tripped.join(", ")}. ` +
        `Invent harder variants of these — the shop is demonstrably weak here.`,
    );
  }
  if (intel.neverExercised.length > 0) {
    parts.push(
      `Rules no journey has reached yet: ${intel.neverExercised.join(", ")}. ` +
        `These are untested, not safe. Design journeys that force them to matter.`,
    );
  }
  if (intel.survived.length > 0) {
    parts.push(
      `Requests the shop handled cleanly: ${intel.survived.join("; ")}. ` +
        `Escalate rather than repeat these.`,
    );
  }

  return parts.length === 0 ? "" : `\n\n${parts.join("\n")}`;
}
