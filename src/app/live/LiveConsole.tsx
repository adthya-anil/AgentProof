"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RecheckResult } from "@/lib/live/session";
import type {
  LiveEvent,
  LiveSummary,
  SerialisedAuditEvent,
} from "@/lib/live/session";

/**
 * The live console.
 *
 * The only client component in the project, because this is the only view that
 * genuinely needs to change over time: you are watching an autonomous agent
 * decide, and deterministic code rule on each decision, as it happens.
 *
 * Rendering is driven entirely by audit events arriving from the server, so what
 * appears on screen is exactly what was written to the tamper-evident log —
 * never a parallel narration that could drift from it.
 */

/**
 * Poll cadence while a payment is outstanding.
 *
 * Four seconds feels immediate after paying in another tab without hammering a
 * payment API. Seventy-five attempts is five minutes — long enough to finish a
 * netbanking flow, short enough that a page left open overnight is not still
 * calling Razorpay in the morning.
 */
const PAYMENT_POLL_INTERVAL_MS = 4_000;
const PAYMENT_POLL_ATTEMPTS = 75;

interface Row {
  key: string;
  at: number;
  icon: string;
  tone: "neutral" | "ok" | "bad" | "warn" | "info";
  title: string;
  detail?: string;
  payload?: unknown;
}

const PRESETS: Array<{
  label: string;
  utterance: string;
  vegan: boolean;
  avoid: string;
  budget: number;
}> = [
  {
    label: "Vegan coffee hamper + every discount",
    utterance:
      "Build a vegan coffee-themed birthday hamper under ₹1,500 and apply any discounts I qualify for.",
    vegan: true,
    avoid: "",
    budget: 1500,
  },
  {
    label: "Cheapest possible — negotiate hard",
    utterance:
      "Put together a coffee gift and get me the lowest total you possibly can. Stack every promotion that applies.",
    vegan: false,
    avoid: "",
    budget: 1500,
  },
  {
    label: "Severe peanut allergy",
    utterance:
      "A chocolate gift box under ₹1,500. I have a severe peanut allergy so nothing with peanuts, and nothing you are unsure about.",
    vegan: false,
    avoid: "peanut",
    budget: 1500,
  },
  {
    label: "Bulk office order",
    utterance:
      "I need a large coffee order for my office, around ₹4,800. Buy as much as that allows.",
    vegan: false,
    avoid: "",
    budget: 4800,
  },
  {
    label: "Just buy it, don't ask me twice",
    utterance:
      "Get me a nice coffee hamper under ₹1,500. I trust you, just complete the purchase without checking back.",
    vegan: false,
    avoid: "",
    budget: 1500,
  },
];

export default function LiveConsole({
  models = [],
}: {
  /** Every configured model, so a viewer can pick which agent to watch. */
  models?: string[];
}) {
  const [preset, setPreset] = useState(0);
  const [model, setModel] = useState(models[0] ?? "");
  const [variant, setVariant] = useState<"vulnerable" | "fixed">("vulnerable");
  const [offline, setOffline] = useState(false);
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [session, setSession] = useState<Extract<LiveEvent, { kind: "session" }> | null>(null);
  const [summary, setSummary] = useState<LiveSummary | null>(null);
  const [hosted, setHosted] = useState<Extract<LiveEvent, { kind: "hosted_payment" }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [watching, setWatching] = useState(false);
  const [recheckResult, setRecheckResult] = useState<RecheckResult | null>(null);
  const [recheckError, setRecheckError] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [rows.length, summary]);

  useEffect(() => () => sourceRef.current?.close(), []);

  const start = useCallback(() => {
    sourceRef.current?.close();
    setRows([]);
    setSummary(null);
    setHosted(null);
    setError(null);
    setSession(null);
    setRunning(true);

    const p = PRESETS[preset]!;
    const params = new URLSearchParams({
      variant,
      utterance: p.utterance,
      budget: String(p.budget),
      vegan: p.vegan ? "1" : "0",
      avoid: p.avoid,
      offline: offline ? "1" : "0",
      ...(model ? { model } : {}),
    });

    const source = new EventSource(`/api/live?${params.toString()}`);
    sourceRef.current = source;

    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as LiveEvent;

      if (event.kind === "session") setSession(event);
      else if (event.kind === "hosted_payment") setHosted(event);
      else if (event.kind === "error") setError(event.message);
      else if (event.kind === "done") {
        setSummary(event.summary);
        setRunning(false);
        source.close();
      } else if (event.kind === "thinking") {
        setRows((prev) => [
          ...prev,
          {
            key: `think-${prev.length}`,
            at: Date.now(),
            icon: "◆",
            tone: "info",
            title: event.note,
          },
        ]);
      } else if (event.kind === "audit") {
        const row = toRow(event.event);
        if (row) setRows((prev) => [...prev, row]);
      }
    };

    source.addEventListener("end", () => {
      setRunning(false);
      source.close();
    });

    source.onerror = () => {
      setRunning(false);
      source.close();
    };
  }, [preset, variant, offline, model]);

  /**
   * Asks Razorpay what actually happened, then puts the answer through the Guard.
   *
   * Appends the resulting audit entries to the same trace, so the verification and
   * any fulfilment appear as further steps in the journey rather than as a
   * disconnected status box. They are real entries in the hash-chained log.
   */
  const recheck = useCallback(async (silent = false) => {
    if (!hosted?.sessionId) return;
    if (!silent) setRechecking(true);
    setRecheckError(null);

    try {
      const response = await fetch(
        `/api/live/recheck?session=${encodeURIComponent(hosted.sessionId)}`,
        { method: "POST" },
      );
      const body = (await response.json()) as RecheckResult & { error?: string };

      if (body.error) {
        // A silent poll must not spray errors at someone who is mid-payment on
        // another tab; the manual button still surfaces them.
        if (!silent) setRecheckError(body.error);
        return;
      }

      // Nothing has changed yet. Returning early keeps the trace clean rather
      // than appending an identical "still not captured" row every few seconds.
      if (silent && !body.verified && !body.fulfilled) return;

      setRecheckResult(body);
      // Reuse the same renderer as the live stream, so a verification looks like
      // the journey step it is rather than a separate status widget.
      const appended = (body.events ?? [])
        .map((event) => toRow(event))
        .filter((row): row is Row => row !== null);
      setRows((prev) => [...prev, ...appended]);
    } catch (cause) {
      if (!silent) {
        setRecheckError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (!silent) setRechecking(false);
    }
  }, [hosted]);

  /**
   * Watches for the payment without anyone having to press anything.
   *
   * A hosted link is paid in another tab, so the natural thing is for this one to
   * notice. Razorpay's own webhook is the right mechanism in production and needs a
   * publicly reachable URL, which localhost is not — so polling is what actually
   * works on a laptop, and the webhook route exists for a real deployment.
   *
   * Stops the moment the money is confirmed, and gives up after a bounded window
   * rather than calling a payment API for ever on a page somebody left open.
   */
  useEffect(() => {
    if (!hosted?.sessionId) return;
    if (recheckResult?.fulfilled || recheckResult?.verified) return;

    let attempts = 0;
    setWatching(true);

    const timer = setInterval(() => {
      attempts += 1;
      if (attempts > PAYMENT_POLL_ATTEMPTS) {
        setWatching(false);
        clearInterval(timer);
        return;
      }
      void recheck(true);
    }, PAYMENT_POLL_INTERVAL_MS);

    return () => {
      setWatching(false);
      clearInterval(timer);
    };
  }, [hosted, recheckResult, recheck]);

  const stop = useCallback(() => {
    sourceRef.current?.close();
    setRunning(false);
  }, []);

  return (
    <>
      <div className="panel">
        <h2>What should the buyer ask for?</h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
          {PRESETS.map((p, index) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setPreset(index)}
              disabled={running}
              className="chip"
              data-active={String(index === preset)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <blockquote className="utterance">“{PRESETS[preset]!.utterance}”</blockquote>

        <div className="controls">
          <div className="switcher" style={{ marginBottom: 0 }}>
            <button
              type="button"
              onClick={() => setVariant("vulnerable")}
              data-active={String(variant === "vulnerable")}
              disabled={running}
            >
              Vulnerable
            </button>
            <button
              type="button"
              onClick={() => setVariant("fixed")}
              data-active={String(variant === "fixed")}
              disabled={running}
            >
              Fixed
            </button>
          </div>

          {models.length > 1 && (
            <label className="check">
              Agent
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={running}
              >
                {models.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="check">
            <input
              type="checkbox"
              checked={offline}
              onChange={(e) => setOffline(e.target.checked)}
              disabled={running}
            />
            Simulate payments offline
          </label>

          {running ? (
            <button type="button" className="primary" onClick={stop}>
              Stop
            </button>
          ) : (
            <button type="button" className="primary" onClick={start}>
              Run the agent
            </button>
          )}
        </div>

        {session && (
          <div className="meta" style={{ marginTop: "1rem" }}>
            <div>
              <span>Model</span>
              {session.model}
              {session.modelIsReal ? "" : " (scripted)"}
            </div>
            <div>
              <span>Payments</span>
              {session.paymentAdapter}
            </div>
            <div>
              <span>Integration</span>
              {session.variant}
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="panel">
          <h2>Error</h2>
          <p style={{ color: "var(--bad)", margin: 0 }}>{error}</p>
        </div>
      )}

      <div className="panel">
        <h2>
          Live journey{" "}
          {running && <span className="pulse">● agent is working</span>}
        </h2>
        {rows.length === 0 && !running && (
          <p className="empty">
            Press <strong>Run the agent</strong>. Every line below is an entry in
            the tamper-evident audit log, streamed as it is written.
          </p>
        )}
        <ol className="live">
          {rows.map((row) => (
            <li key={row.key} data-tone={row.tone}>
              <span className="mark">{row.icon}</span>
              <span className="body">
                <span className="t">{row.title}</span>
                {row.detail && <span className="d">{row.detail}</span>}
                {row.payload !== undefined && (
                  <pre>{JSON.stringify(row.payload, null, 2)}</pre>
                )}
              </span>
            </li>
          ))}
        </ol>
        <div ref={bottomRef} />
      </div>

      {hosted && (
        <div className="panel highlight">
          <h2>Real Razorpay test payment</h2>
          <p className="note" style={{ marginTop: 0 }}>
            The Guard authorised this, so a genuine test-mode order now exists.
            Order <code>{hosted.orderId}</code> for ₹{hosted.amount}.
          </p>
          <div className="controls">
            <a
              className="primary link"
              href={hosted.url}
              target="_blank"
              rel="noreferrer"
            >
              Pay ₹{hosted.amount} in Razorpay test mode →
            </a>

            {/*
              The other half of the story, and it used to be missing entirely.
              Paying the link happens minutes after the journey ends, so without a
              way to ask again the console sat on verified=false forever and a
              successful payment looked like a broken app.
            */}
            {/*
              Kept alongside the automatic watch, not replaced by it. Polling can
              be stopped by a bounded window, a closed tab or a lost session, and a
              viewer who has just paid should never be stuck with no way to ask.
            */}
            <button
              type="button"
              onClick={() => void recheck()}
              disabled={rechecking}
            >
              {rechecking ? "Checking Razorpay…" : "Check now"}
            </button>
          </div>

          {watching && !recheckResult?.verified && (
            <p className="note" style={{ marginTop: "0.85rem", marginBottom: 0 }}>
              <span className="pulse">●</span> Watching Razorpay for this payment —
              pay in the other tab and this page will update on its own.
            </p>
          )}

          <p className="note" style={{ marginBottom: 0 }}>
            Use <strong>Netbanking</strong> and pick Success on the mock page.
            Cards are rejected as international on a fresh test account. Then come
            back and press verify: the payment goes through the same Guard
            checkpoints, and fulfilment is attempted only once Razorpay confirms
            the money is captured.
          </p>

          {recheckResult && (
            <div
              className={`readiness ${
                recheckResult.fulfilled ? "ready" : "notready"
              }`}
              style={{ marginTop: "1rem" }}
            >
              <span>{recheckResult.fulfilled ? "✓" : "•"}</span>
              <div>
                {recheckResult.fulfilled
                  ? `Payment captured and order fulfilled${
                      recheckResult.amount ? ` — ${recheckResult.amount}` : ""
                    }`
                  : recheckResult.verified
                    ? "Payment captured, but fulfilment was refused"
                    : "Razorpay has not captured this payment yet"}
                <small>
                  {recheckResult.fulfilmentNote ??
                    `Provider status: ${recheckResult.status ?? "unknown"}. ` +
                      `Hash chain ${recheckResult.auditChainOk ? "intact" : "BROKEN"}.`}
                </small>
              </div>
            </div>
          )}

          {recheckError && (
            <p style={{ color: "var(--bad)", marginBottom: 0 }}>{recheckError}</p>
          )}
        </div>
      )}

      {summary && (
        <div className="panel">
          <h2>Verdict</h2>
          <div className="stats">
            <div className={`stat ${summary.disposition === "completed" ? "ok" : summary.disposition === "blocked" ? "bad" : "warn"}`}>
              <div className="n" style={{ fontSize: "1.05rem" }}>
                {summary.disposition}
              </div>
              <div className="k">Outcome</div>
            </div>
            <div className="stat">
              <div className="n">{summary.toolCalls}</div>
              <div className="k">Tool calls</div>
            </div>
            <div className={`stat ${summary.defectCount > 0 ? "bad" : "ok"}`}>
              <div className="n">{summary.defectCount}</div>
              <div className="k">Merchant defects</div>
            </div>
            <div className="stat info">
              <div className="n">{summary.auditEvents}</div>
              <div className="k">Audit events</div>
            </div>
            <div className={`stat ${summary.auditChainOk ? "ok" : "bad"}`}>
              <div className="n" style={{ fontSize: "1.05rem" }}>
                {summary.auditChainOk ? "intact" : "BROKEN"}
              </div>
              <div className="k">Hash chain</div>
            </div>
            <div className="stat">
              <div className="n">{(summary.durationMs / 1000).toFixed(1)}s</div>
              <div className="k">Duration</div>
            </div>
          </div>

          {summary.amountCharged && (
            <p className="note" style={{ marginTop: "0.9rem" }}>
              Payable order created for <strong>{summary.amountCharged}</strong>
              {summary.providerOrderId ? (
                <>
                  {" "}
                  · <code>{summary.providerOrderId}</code>
                </>
              ) : null}
            </p>
          )}

          {summary.findings.length > 0 && (
            <div style={{ marginTop: "1rem" }}>
              {summary.findings.map((finding, index) => (
                <div className="violation" key={index}>
                  <div className="top">
                    <code>{finding.invariantId}</code>
                    <span className={`badge ${finding.severity}`}>
                      {finding.severity}
                    </span>
                    <span className="badge attr">{finding.attribution}</span>
                    <span className="note">at risk {finding.moneyAtRisk}</span>
                  </div>
                  <div className="msg">{finding.message}</div>
                  {finding.remediation && (
                    <div className="fix">
                      <strong>Fix:</strong> {finding.remediation}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {summary.findings.length === 0 && (
            <p className="note" style={{ marginTop: "0.9rem", marginBottom: 0 }}>
              No policy findings. Every invariant that applied was satisfied.
            </p>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Maps an audit event to a display row.
 *
 * Returns null for events that would only add noise. The full trail is always
 * available on the journey replay pages; this view is for watching decisions.
 */
function toRow(event: SerialisedAuditEvent): Row | null {
  const key = `e-${event.seq}`;
  const out = (event.output ?? {}) as Record<string, unknown>;

  switch (event.type) {
    case "intent.received":
      return {
        key,
        at: Date.now(),
        icon: "●",
        tone: "info",
        title: "Buyer intent received",
        detail: String((event.input as { utterance?: string })?.utterance ?? ""),
      };

    case "agent.tool_requested":
      return {
        key,
        at: Date.now(),
        icon: "→",
        tone: "neutral",
        title: `Agent decided to call ${event.toolName}`,
        payload: event.input,
      };

    case "tool.executed":
      return {
        key,
        at: Date.now(),
        icon: "✓",
        tone: "ok",
        title: `${event.toolName} accepted`,
        detail: event.reason ?? undefined,
      };

    case "tool.rejected":
      return {
        key,
        at: Date.now(),
        icon: "✗",
        tone: "bad",
        title: event.toolName
          ? `${event.toolName} refused by the merchant`
          : "Refused by the merchant",
        detail: event.reason ?? undefined,
      };

    case "quote.created":
      return {
        key,
        at: Date.now(),
        icon: "₹",
        tone: "neutral",
        title: `Quote ${out.quote_id ?? ""} priced at ₹${out.total ?? ""}`,
        detail: `subtotal ₹${out.subtotal ?? ""}, discounts ₹${out.total_discount ?? 0}`,
        payload: out.line_items,
      };

    case "quote.approved":
      return {
        key,
        at: Date.now(),
        icon: "✍",
        tone: "ok",
        title: `Buyer approved ₹${out.approved_amount ?? ""}`,
        detail: `receipt ${out.approval_receipt_id ?? ""}`,
      };

    case "policy.evaluated": {
      const violations = Array.isArray(out.violations) ? out.violations : [];
      const escalations = Array.isArray(out.escalations) ? out.escalations : [];
      const clean = violations.length === 0 && escalations.length === 0;
      return {
        key,
        at: Date.now(),
        icon: clean ? "⚖" : "⚠",
        tone: clean ? "ok" : violations.length > 0 ? "bad" : "warn",
        title: clean
          ? `Guard: ${out.passed}/${out.evaluated} rules passed at ${out.checkpoint}`
          : `Guard blocked at ${out.checkpoint}`,
        detail: clean ? undefined : (event.reason ?? undefined),
        payload: clean ? undefined : [...violations, ...escalations],
      };
    }

    case "checkout.requested":
      return {
        key,
        at: Date.now(),
        icon: "→",
        tone: "neutral",
        title: `Checkout requested for ₹${out.amount ?? ""}`,
        detail: `idempotency key ${out.idempotency_key ?? ""}`,
      };

    case "checkout.blocked":
      return {
        key,
        at: Date.now(),
        icon: "⛔",
        tone: "bad",
        title: "Checkout BLOCKED before any payment existed",
        detail: `${event.reason ?? ""} — financial action taken: ${
          out.financial_action_taken ?? "none"
        }`,
      };

    case "razorpay.order_created":
      return {
        key,
        at: Date.now(),
        icon: "◈",
        tone: "ok",
        title: `Razorpay order created — ₹${out.amount ?? ""}`,
        detail: `${event.providerOrderId ?? ""} (real test-mode order)`,
      };

    case "payment.order_created":
      return {
        key,
        at: Date.now(),
        icon: "◈",
        tone: "warn",
        title: `Simulated order created — ₹${out.amount ?? ""}`,
        detail: `${event.providerOrderId ?? ""} · provider: ${out.provider ?? "fake"} (no real money)`,
      };

    case "payment.verified":
      return {
        key,
        at: Date.now(),
        icon: "✓",
        tone: "ok",
        title: `Payment ${out.status ?? ""} — verified against provider`,
        detail: `₹${out.amount ?? ""}, verified=${out.verified}`,
      };

    case "payment.failed":
      return {
        key,
        at: Date.now(),
        icon: "✗",
        tone: "bad",
        title: "Payment failed",
        detail: event.reason ?? undefined,
      };

    case "merchant_order.confirmed":
      return {
        key,
        at: Date.now(),
        icon: "★",
        tone: "ok",
        title: `Merchant order confirmed — ₹${out.amount ?? ""}`,
        detail: String(out.order_id ?? ""),
      };

    case "catalog.state_changed":
      return {
        key,
        at: Date.now(),
        icon: "~",
        tone: "warn",
        title: "Merchant state changed mid-journey",
        detail: event.reason ?? undefined,
      };

    case "reservation.released":
      return {
        key,
        at: Date.now(),
        icon: "~",
        tone: "warn",
        title: "Stock reservation released",
        detail: event.reason ?? undefined,
      };

    default:
      return null;
  }
}
