import { BuyerAgent } from "../agent/buyer.js";
import { randomUUID } from "node:crypto";
import { llmFromEnv, llmPoolFromEnv } from "../agent/factory.js";
import {
  findSessionByProviderId,
  getSession,
  rememberSession,
} from "./sessionStore.js";
import type { AuditEvent } from "../audit/events.js";
import { ManualClock } from "../core/clock.js";
import { IdFactory } from "../core/ids.js";
import { formatMinor, toMajor } from "../core/money.js";
import { createEnvironment, createIntent } from "../harness.js";
import { MutationSet } from "../hamperhub/mutations.js";
import { describeAdapter, selectPaymentAdapter } from "../payments/factory.js";
import { integrationDefects } from "../policy/violations.js";

/**
 * A live buyer-agent session, streamed as it happens.
 *
 * The other views render a finished run, which is accurate but hides the thing
 * worth seeing: an autonomous agent choosing its next move, and deterministic
 * code ruling on each one. This drives a real model against the real Guard and
 * emits every event the moment it is recorded.
 *
 * It subscribes to the audit log rather than instrumenting the agent, because the
 * log is already the single record every component writes to. Watching it means
 * the stream cannot drift from what actually happened.
 */

export type LiveEvent =
  | { kind: "session"; model: string; modelIsReal: boolean; paymentAdapter: string; variant: string; utterance: string }
  | { kind: "audit"; event: SerialisedAuditEvent }
  | { kind: "thinking"; note: string }
  | {
      kind: "hosted_payment";
      url: string;
      orderId: string;
      amount: number;
      /** Pass to /api/live/recheck once the link has been paid. */
      sessionId: string;
    }
  | { kind: "done"; summary: LiveSummary }
  | { kind: "error"; message: string };

export interface SerialisedAuditEvent {
  seq: number;
  at: string;
  type: string;
  toolName: string | null;
  decision: string | null;
  reason: string | null;
  output: unknown;
  input: unknown;
  providerOrderId: string | null;
  hash: string;
}

export interface LiveSummary {
  disposition: "completed" | "blocked" | "escalated" | "rejected" | "incomplete";
  toolCalls: number;
  findings: Array<{
    invariantId: string;
    severity: string;
    attribution: string;
    message: string;
    remediation: string | null;
    moneyAtRisk: string;
  }>;
  /** Findings that mean the merchant's code is at fault. */
  defectCount: number;
  providerOrderId: string | null;
  amountCharged: string | null;
  auditChainOk: boolean;
  auditEvents: number;
  durationMs: number;
  finalMessage: string;
}

export interface LiveSessionOptions {
  variant: "vulnerable" | "fixed";
  utterance: string;
  maxBudget?: number;
  requireVegan?: boolean;
  mustAvoidAllergens?: string[];
  /** Force the offline provider even when Razorpay is configured. */
  offlinePayments?: boolean;
  maxToolCalls?: number;
  /**
   * Which configured model to watch, by name. Falls back to the primary adapter
   * when unset or unmatched — a stale bookmark should not break the console.
   */
  model?: string;
}

/**
 * Picks a model from the configured pool by name.
 *
 * Falls back rather than throwing, because the name arrives from a query string:
 * a stale link or a renamed deployment should start the session on the primary
 * model, not show the viewer an error.
 */
function selectModel(requested?: string) {
  if (!requested) return llmFromEnv();
  const match = llmPoolFromEnv().find((llm) => llm.name === requested);
  return match ?? llmFromEnv();
}

function serialise(event: AuditEvent): SerialisedAuditEvent {
  return {
    seq: event.seq,
    at: event.at.toISOString(),
    type: event.type,
    toolName: event.toolName,
    decision: event.decision,
    reason: event.reason,
    output: event.output,
    input: event.input,
    providerOrderId: event.providerOrderId,
    hash: event.hash,
  };
}

/**
 * Runs a session, invoking `emit` for every event as it occurs.
 *
 * Deliberately never throws: a model outage or a provider error is part of what
 * a viewer should see, so failures are emitted as events rather than collapsing
 * the stream.
 */
export async function runLiveSession(
  options: LiveSessionOptions,
  emit: (event: LiveEvent) => void,
): Promise<void> {
  const startedAt = Date.now();

  try {
    const clock = new ManualClock(new Date());
    const ids = new IdFactory(`live-${Date.now()}`);

    // A hosted payment link is the only way a browser viewer can complete a real
    // payment, so prefer it whenever Razorpay is configured.
    const selection = options.offlinePayments
      ? null
      : selectPaymentAdapter({ ids, clock, collectionMode: "payment_link" });

    const usingReal = selection?.available === true && selection.kind === "razorpay";

    const env = createEnvironment({
      mutations:
        options.variant === "vulnerable"
          ? MutationSet.vulnerable()
          : MutationSet.fixed(),
      clock,
      mode: "runtime",
      ...(usingReal && selection?.available
        ? { paymentProvider: selection.provider }
        : {}),
    });

    const llm = selectModel(options.model);

    emit({
      kind: "session",
      model: llm.name,
      modelIsReal: llm.isReal,
      paymentAdapter: selection ? describeAdapter(selection) : "fake (offline)",
      variant: options.variant,
      utterance: options.utterance,
    });

    const intent = createIntent(env.ids, env.clock, {
      runId: `live_${Date.now()}`,
      utterance: options.utterance,
      maxBudget: options.maxBudget,
      requireVegan: options.requireVegan ?? false,
      mustAvoidAllergens: options.mustAvoidAllergens ?? [],
    });

    // Stream every event the instant it is appended.
    const unsubscribe = env.audit.subscribe((event) => {
      emit({ kind: "audit", event: serialise(event) });
    });

    env.guard.beginIntent(intent);

    if (llm.isReal) {
      emit({
        kind: "thinking",
        note: `${llm.name} is choosing its own tool sequence. No script.`,
      });
    }

    const agent = new BuyerAgent({
      llm,
      guard: env.guard,
      // Generous, and matched to the preflight budget. A reasoning model spends
      // several calls exploring the catalogue before it commits, and a viewer
      // watching a journey get cut off mid-purchase learns the wrong lesson.
      maxToolCalls: options.maxToolCalls ?? 24,
    });

    const run = await agent.run(intent);

    // Surface a payable link so the viewer can finish a real payment.
    const authorised = env.service
      .listCheckoutIntents(intent.id)
      .find((c) => c.status === "authorized");
    const attempt = authorised
      ? env.service.findPaymentAttemptForCheckout(authorised.id)
      : undefined;

    if (attempt?.hostedUrl && authorised) {
      /**
       * Keep the session reachable so the payment can be re-checked.
       *
       * Paying a hosted link happens minutes after the journey ends. Without this
       * the environment was discarded on return, so a successful payment could
       * never be reflected — the console sat on `verified=false` forever because
       * nothing was ever going to look again.
       */
      const sessionId = randomUUID();
      rememberSession({
        id: sessionId,
        env,
        intent,
        checkoutIntentId: authorised.id,
        paymentAttemptId: attempt.id,
        hostedUrl: attempt.hostedUrl,
        providerOrderId: attempt.providerOrderId,
        createdAt: Date.now(),
      });

      emit({
        kind: "hosted_payment",
        url: attempt.hostedUrl,
        orderId: attempt.providerOrderId,
        amount: toMajor(attempt.amountMinor),
        sessionId,
      });
    }

    unsubscribe();

    const violations = [...env.guard.recordedViolations()];
    const escalations = [...env.guard.recordedEscalations()];
    const all = [...violations, ...escalations];
    const chain = env.audit.verify();

    const disposition: LiveSummary["disposition"] =
      violations.length > 0
        ? "blocked"
        : escalations.length > 0
          ? "escalated"
          : run.reachedCheckout
            ? "completed"
            : run.transcript.some((t) => !t.ok)
              ? "rejected"
              : "incomplete";

    emit({
      kind: "done",
      summary: {
        disposition,
        toolCalls: run.toolCalls,
        findings: all.map((v) => ({
          invariantId: v.invariantId,
          severity: v.severity,
          attribution: v.attribution,
          message: v.message,
          remediation: v.remediation,
          moneyAtRisk: formatMinor(v.moneyAtRiskMinor),
        })),
        defectCount: integrationDefects(violations).length,
        providerOrderId: attempt?.providerOrderId ?? null,
        amountCharged: attempt ? formatMinor(attempt.amountMinor) : null,
        auditChainOk: chain.ok,
        auditEvents: env.audit.all().length,
        durationMs: Date.now() - startedAt,
        finalMessage: run.finalMessage,
      },
    });
  } catch (error) {
    emit({
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}


/** What a re-check found, and what the Guard did about it. */
export interface RecheckResult {
  found: boolean;
  /** Provider-reported payment state, e.g. "captured". */
  status: string | null;
  verified: boolean;
  /** True when the merchant recorded the order as fulfilled. */
  fulfilled: boolean;
  /** Why fulfilment was refused, when it was. */
  fulfilmentNote: string | null;
  /** Audit entries appended by this re-check, so the console can show them. */
  events: SerialisedAuditEvent[];
  auditChainOk: boolean;
  amount: string | null;
}

/**
 * Re-verifies a hosted payment after a human has paid it, then tries to fulfil.
 *
 * This is the other half of the real-payment story and it was missing. The agent
 * creates a payment link and stops, because `INV-PAYMENT-STATE` correctly refuses
 * to fulfil an uncaptured payment — so the run ends with `verified=false` and that
 * is the *right* answer at that moment. What was wrong is that paying the link
 * afterwards changed nothing, since nobody ever asked the provider again.
 *
 * Deliberately goes back through the Guard rather than reading Razorpay and
 * updating a field. The point of the product is that money moves only when the
 * invariants agree, and that has to hold for the last step too.
 */
export async function recheckPayment(
  sessionId: string,
): Promise<RecheckResult> {
  const session = getSession(sessionId);
  if (!session) {
    return {
      found: false,
      status: null,
      verified: false,
      fulfilled: false,
      fulfilmentNote:
        "This session is no longer held in memory. Re-checks are kept for an " +
        "hour, and are lost when the server restarts.",
      events: [],
      auditChainOk: true,
      amount: null,
    };
  }

  const { env } = session;
  const before = env.audit.all().length;

  // Straight back through the Guard: this really calls Razorpay.
  const status = await env.guard.callTool("get_payment_status", {
    payment_attempt_id: session.paymentAttemptId,
  });

  const attempt = env.service.getPaymentAttempt(session.paymentAttemptId);
  let fulfilled = false;
  let fulfilmentNote: string | null = null;

  // Only worth attempting once the provider says the money is actually there.
  if (attempt?.verified) {
    const result = env.guard.fulfillOrder(session.checkoutIntentId);
    fulfilled = result.ok;
    if (!result.ok) fulfilmentNote = result.reason;
  } else {
    fulfilmentNote =
      "Razorpay still does not report this payment as captured, so fulfilment " +
      "was not attempted. INV-PAYMENT-STATE would refuse it.";
  }

  return {
    found: true,
    status: attempt?.status ?? (status.ok ? "unknown" : null),
    verified: attempt?.verified ?? false,
    fulfilled,
    fulfilmentNote,
    events: env.audit.all().slice(before).map(serialise),
    auditChainOk: env.audit.verify().ok,
    amount: attempt ? formatMinor(attempt.amountMinor) : null,
  };
}


/**
 * Re-checks the session a provider identifier belongs to.
 *
 * The entry point for a webhook, which knows about payment links and orders and
 * nothing about our session ids. Shares every step with the manual re-check on
 * purpose: a payment must not be settled by a different, laxer code path just
 * because a provider asked rather than a person.
 */
export async function recheckPaymentForProviderId(
  providerId: string,
): Promise<RecheckResult> {
  const session = findSessionByProviderId(providerId);
  if (!session) {
    return {
      found: false,
      status: null,
      verified: false,
      fulfilled: false,
      fulfilmentNote: `No live session is holding provider order ${providerId}.`,
      events: [],
      auditChainOk: true,
      amount: null,
    };
  }
  return recheckPayment(session.id);
}
