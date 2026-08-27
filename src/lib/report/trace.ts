import type { AuditEvent } from "../audit/events.js";
import type { AuditLog } from "../audit/log.js";

/**
 * Renders an audit trail as the timestamped replay shown in the report (§9).
 *
 * Offsets are relative to the first event so a reader sees "00:04" rather than
 * an absolute timestamp — the shape of the failure matters more than the wall
 * clock, and relative offsets stay stable across reruns.
 */
export function renderTrace(
  events: readonly AuditEvent[],
  opts: { showPasses?: boolean } = {},
): string {
  if (events.length === 0) return "(no events)";
  const start = events[0]!.at.getTime();
  const lines: string[] = [];

  for (const event of events) {
    const offset = formatOffset(event.at.getTime() - start);
    const summary = summarizeEvent(event, opts.showPasses ?? false);
    if (summary === null) continue;
    lines.push(`${offset}  ${summary}`);
  }
  return lines.join("\n");
}

function formatOffset(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function summarizeEvent(event: AuditEvent, showPasses: boolean): string | null {
  const output = (event.output ?? {}) as Record<string, unknown>;

  switch (event.type) {
    case "intent.received": {
      const input = (event.input ?? {}) as Record<string, unknown>;
      return `Buyer intent created: "${input.utterance}"`;
    }
    case "agent.tool_requested":
      return `Agent requested ${event.toolName}(${compact(event.input)})`;
    case "tool.executed":
      return `${event.toolName} executed — ${event.reason ?? "ok"}`;
    case "tool.rejected":
      // Not every rejection comes from an agent tool call: fulfilment is
      // merchant-initiated and carries no tool name.
      return event.toolName
        ? `${event.toolName} rejected — ${event.reason}`
        : `Rejected — ${event.reason}`;
    case "quote.created": {
      const total = output.total;
      const discounts = Array.isArray(output.discounts) ? output.discounts : [];
      const parts = [`Quote ${output.quote_id} created: ₹${total}`];
      for (const discount of discounts as Array<Record<string, unknown>>) {
        parts.push(`${discount.code} -₹${discount.amount}`);
      }
      return parts.join(" | ");
    }
    case "policy.evaluated": {
      const violations = Array.isArray(output.violations) ? output.violations : [];
      const escalations = Array.isArray(output.escalations)
        ? output.escalations
        : [];
      if (violations.length === 0 && escalations.length === 0) {
        return showPasses
          ? `Policy evaluated at ${output.checkpoint}: ${output.passed}/${output.evaluated} passed`
          : null;
      }
      const rendered = [
        ...(violations as Array<Record<string, unknown>>).map(
          (v) =>
            `AgentProof verdict: ${String(v.severity).toUpperCase()} VIOLATION ` +
            `[${v.invariant}] ${v.message}`,
        ),
        ...(escalations as Array<Record<string, unknown>>).map(
          (v) => `AgentProof verdict: ESCALATE [${v.invariant}] ${v.message}`,
        ),
      ];
      return rendered.join("\n       ");
    }
    case "quote.approved":
      return `Buyer approved ₹${output.approved_amount} for quote ${event.quoteId} v${output.quote_version}`;
    case "checkout.requested":
      return `Checkout requested: ₹${output.amount} (key ${output.idempotency_key})`;
    case "checkout.blocked":
      return (
        `Decision: BLOCKED — ${event.reason}\n` +
        `       Financial action taken: ${output.financial_action_taken}\n` +
        `       Required next action: ${output.required_next_action}`
      );
    case "razorpay.order_created": {
      // A hosted payment link and a bare order are both payable artefacts, but
      // calling a link an "order" in a replay is needlessly confusing.
      const kind = event.providerOrderId?.startsWith("plink_")
        ? "payment link"
        : "order";
      return `Razorpay ${kind} created: ${event.providerOrderId} for ₹${output.amount}`;
    }
    case "payment.verified":
      return `Payment ${output.status} (verified=${output.verified}) ₹${output.amount}`;
    case "payment.failed":
      return `Payment failed — ${event.reason}`;
    case "merchant_order.confirmed":
      return `Merchant order ${output.order_id} confirmed for ₹${output.amount}`;
    case "reservation.released":
      return `Reservation released — ${event.reason}`;
    case "catalog.state_changed":
      return `State changed — ${event.reason}`;
    case "run.started":
    case "run.completed":
      return `${event.type}: ${event.reason ?? ""}`;
    default:
      return `${event.type}`;
  }
}

function compact(value: unknown): string {
  if (value === null || value === undefined) return "";
  const json = JSON.stringify(value);
  return json.length > 120 ? `${json.slice(0, 120)}…` : json;
}

export function renderChainStatus(audit: AuditLog): string {
  const result = audit.verify();
  return result.ok
    ? `audit chain verified (${audit.all().length} events, head ${audit.head().slice(0, 12)}…)`
    : `AUDIT CHAIN BROKEN at seq ${result.brokenAtSeq}`;
}
