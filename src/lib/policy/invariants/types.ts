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

export type InvariantOutcome =
  | { status: "pass"; detail?: string }
  | { status: "skipped"; detail: string }
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
  evaluate(ctx: EvaluationContext): InvariantOutcome;
}

export function pass(detail?: string): InvariantOutcome {
  return detail ? { status: "pass", detail } : { status: "pass" };
}

export function skip(detail: string): InvariantOutcome {
  return { status: "skipped", detail };
}

export function violation(detail: ViolationDetail): InvariantOutcome {
  return { status: "violation", ...detail };
}

export function escalate(detail: ViolationDetail): InvariantOutcome {
  return { status: "escalation", ...detail };
}
