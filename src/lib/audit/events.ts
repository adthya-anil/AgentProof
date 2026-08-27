/** Event vocabulary from the AgentProof spec (§13). Append-only, never edited. */
export const AUDIT_EVENT_TYPES = [
  "intent.received",
  "agent.tool_requested",
  "tool.executed",
  "tool.rejected",
  "catalog.state_changed",
  "quote.created",
  "policy.evaluated",
  "quote.approved",
  "checkout.requested",
  "checkout.blocked",
  "razorpay.order_created",
  "payment.verified",
  "payment.failed",
  "merchant_order.confirmed",
  "reservation.released",
  "run.started",
  "run.completed",
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export type GuardDecision = "allow" | "block" | "escalate" | "not_applicable";

export type ViolationSeverity = "critical" | "high" | "medium" | "info";

export interface AuditEventInput {
  type: AuditEventType;
  runId: string;
  intentId?: string | null;
  toolName?: string | null;
  /** Inputs are sanitized before they reach here; never store raw credentials. */
  input?: unknown;
  output?: unknown;
  policyVersion?: string | null;
  decision?: GuardDecision | null;
  /** Short, human-readable justification. Never model chain-of-thought. */
  reason?: string | null;
  quoteId?: string | null;
  providerOrderId?: string | null;
  violationIds?: string[];
}

export interface AuditEvent extends AuditEventInput {
  /** Global monotonic sequence number across the whole log. */
  seq: number;
  at: Date;
  intentId: string | null;
  toolName: string | null;
  policyVersion: string | null;
  decision: GuardDecision | null;
  reason: string | null;
  quoteId: string | null;
  providerOrderId: string | null;
  violationIds: string[];
  prevHash: string;
  hash: string;
}

/**
 * Keys whose values must never be persisted, even if a tool happens to echo
 * them back. The Guard is the only component holding payment credentials and
 * the agent never sees them, but defence in depth is cheap here.
 */
const REDACTED_KEYS = new Set([
  "key_secret",
  "keysecret",
  "razorpay_key_secret",
  "secret",
  "password",
  "authorization",
  "api_key",
  "apikey",
  "llm_api_key",
  "token",
]);

export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    return value.length > 2000 ? `${value.slice(0, 2000)}…[truncated]` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => sanitize(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACTED_KEYS.has(key.toLowerCase())
        ? "[redacted]"
        : sanitize(val, depth + 1);
    }
    return out;
  }
  return String(value);
}
