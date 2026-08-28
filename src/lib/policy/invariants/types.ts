import type { ViolationSeverity } from "../../audit/events.js";
import type { Clock } from "../../core/clock.js";
import type { Minor } from "../../core/money.js";
import type {
  ApprovalReceipt,
  BuyerIntent,
  CheckoutIntent,
  InventoryRecord,
  Order,
  PaymentAttempt,
  Product,
  Quote,
  Reservation,
} from "../../core/types.js";
import type { Capability, CapabilitySet } from "../capabilities.js";
import type { Policy } from "../schema.js";

/** Points in the transaction lifecycle at which the Guard evaluates policy. */
export const CHECKPOINTS = [
  "quote.created",
  "quote.approved",
  "checkout.requested",
  "payment.verified",
  "order.fulfilled",
] as const;

export type Checkpoint = (typeof CHECKPOINTS)[number];

/**
 * Read-only view of live merchant state.
 *
 * Invariants depend on this narrow interface rather than the concrete
 * `MerchantState` so the policy engine stays independent of the merchant
 * implementation — the same engine can front a different commerce backend.
 */
export interface LiveCatalogView {
  getProduct(productId: string): Product | undefined;
  getInventory(productId: string): InventoryRecord | undefined;
  freeStock(productId: string): number;
  getReservation(reservationId: string): Reservation | undefined;
}

export interface EvaluationContext {
  checkpoint: Checkpoint;
  policy: Policy;
  policyVersion: string;
  clock: Clock;
  /** Live state, re-read at evaluation time. Never a cached snapshot. */
  catalog: LiveCatalogView;
  intent: BuyerIntent;
  quote?: Quote | null;
  approval?: ApprovalReceipt | null;
  checkoutIntent?: CheckoutIntent | null;
  paymentAttempt?: PaymentAttempt | null;
  order?: Order | null;
  /** Every checkout intent already recorded for this buyer intent. */
  priorCheckoutIntents?: readonly CheckoutIntent[];
  /** Payment attempts already made, used for duplicate-order detection. */
  priorPaymentAttempts?: readonly PaymentAttempt[];
  /**
   * What this merchant can actually supply.
   *
   * Required, not optional with a permissive default. A default of "assume
   * everything" would mean any adapter that forgot to declare its capabilities got
   * every rule run against fields it does not have — and those rules would compare
   * `undefined` to `undefined`, pass, and report full coverage. The one thing this
   * mechanism exists to prevent would be its own default behaviour.
   */
  capabilities: CapabilitySet;
}

/**
 * Who is responsible for a finding.
 *
 * This is the difference between an honest report and a misleading one. The
 * Guard blocking a greedy agent is not evidence of a merchant bug, and a
 * mid-flight stock-out is nobody's bug at all. Only `integration` findings mean
 * the code under test would have let money move incorrectly.
 */
export type Attribution = "integration" | "agent" | "environment";

export interface ViolationDetail {
  message: string;
  observed?: Record<string, unknown>;
  expected?: Record<string, unknown>;
  /** Amount that would have moved incorrectly had the Guard not intervened. */
  moneyAtRiskMinor?: Minor;
  severity?: ViolationSeverity;
  remediation?: string;
  /** Overrides the invariant's default attribution for this specific outcome. */
  attribution?: Attribution;
}

/**
 * Why a rule did not run.
 *
 * `not_applicable` is coverage working: a payment-state rule has nothing to say at
 * quote time. `missing_capability` is a permanent hole: the rule cannot run against
 * this merchant at any checkpoint, because the data it compares does not exist. Both
 * are skips, and reporting them as one number would let a merchant read a full green
 * board while three rules never executed.
 */
export type SkipReason = "not_applicable" | "missing_capability";

export type InvariantOutcome =
  | { status: "pass"; detail?: string }
  | {
      status: "skipped";
      detail: string;
      /** Defaults to `not_applicable`, which is what a bare `skip()` means. */
      reason?: SkipReason;
      /** Populated by the engine when it withheld the rule itself. */
      missing?: readonly Capability[];
    }
  | ({ status: "violation" } & ViolationDetail)
  /** Policy cannot decide automatically; a human must approve. Not a defect. */
  | ({ status: "escalation" } & ViolationDetail);

export interface Invariant {
  id: string;
  title: string;
  severity: ViolationSeverity;
  /** Policy keys this rule derives from, surfaced in the report. */
  policyRefs: string[];
  /** Default responsibility for a breach of this rule. */
  attribution: Attribution;
  appliesAt: readonly Checkpoint[];
  /**
   * Merchant capabilities this rule cannot work without.
   *
   * Omitted means the rule needs nothing beyond what the Guard itself constructs, so
   * it runs against every merchant. Declared capabilities are enforced by the engine
   * before `evaluate` is called, so an invariant body never has to defend against a
   * field its declaration already required.
   */
  requires?: readonly Capability[];
  evaluate(ctx: EvaluationContext): InvariantOutcome;
}

export function pass(detail?: string): InvariantOutcome {
  return detail ? { status: "pass", detail } : { status: "pass" };
}

export function skip(detail: string): InvariantOutcome {
  return { status: "skipped", detail, reason: "not_applicable" };
}

/** A rule withheld because the merchant cannot supply what it compares. */
export function unsupported(
  detail: string,
  missing: readonly Capability[],
): InvariantOutcome {
  return { status: "skipped", detail, reason: "missing_capability", missing };
}

export function violation(detail: ViolationDetail): InvariantOutcome {
  return { status: "violation", ...detail };
}

export function escalate(detail: ViolationDetail): InvariantOutcome {
  return { status: "escalation", ...detail };
}
