import type { Currency } from "./money.js";
import type { ViolationSeverity } from "../audit/events.js";
import type { Attribution, Checkpoint } from "../policy/invariants/types.js";

/**
 * Spec entities that previously existed only implicitly (§15).
 *
 * `Merchant` was hard-coded, and `CommerceTool`, `PolicyRule`, `TestRun` and
 * `ToolExecution` lived as internal shapes under different names. Naming them
 * matters now that runs are persisted: these are the rows a reviewer queries, so
 * the type and the table should agree.
 *
 * These are descriptive projections of data the engine already produces, not a
 * second source of truth. Nothing here re-derives a financial figure.
 */

export interface Merchant {
  id: string;
  name: string;
  currency: Currency;
}

/** The single demonstration merchant. */
export const HAMPERHUB: Merchant = {
  id: "hamperhub",
  name: "HamperHub Gift Store",
  currency: "INR",
};

/** A tool exposed to a buyer agent, as the agent is told about it. */
export interface CommerceTool {
  name: string;
  merchantId: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * One deterministic rule, projected from an `Invariant`.
 *
 * The spec's `Policy -> many PolicyRules`. The invariant remains the executable
 * artefact; this is its persistable description.
 */
export interface PolicyRule {
  id: string;
  policyVersion: string;
  title: string;
  severity: ViolationSeverity;
  attribution: Attribution;
  policyRefs: string[];
  checkpoints: Checkpoint[];
}

/** A single tool call and its outcome. The spec's ToolExecution. */
export interface ToolExecution {
  seq: number;
  toolName: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  summary: string;
}

/**
 * A stored journey execution: the spec's `TestRun`.
 *
 * `JourneyResult` is the in-memory result with live object references; this is
 * the persisted, queryable form, identified by a UUID rather than a scenario id
 * because the same scenario is run many times across suites.
 */
export interface TestRunRecord {
  id: string;
  suiteId: string;
  scenarioId: string;
  runLabel: string;
  intentId: string | null;
  title: string;
  category: string;
  targetsInvariant: string | null;
  disposition: string;
  note: string;
  firedInvariants: string[];
  moneyAtRiskMinor: number;
  providerOrders: number;
  duplicatePayableOrders: number;
  selfRejected: boolean;
  auditEvents: number;
  auditChainOk: boolean;
  durationMs: number;
  /** Time from the first event to the first violation, when one occurred. */
  msToFirstViolation: number | null;
  error: string | null;
}
