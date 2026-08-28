import Link from "next/link";
import type { AuditEvent } from "@/lib/audit/events";
import { formatMinor, roundPercent } from "@/lib/core/money";
import type { JourneyDisposition } from "@/lib/runner/run";
import type { ScenarioDriver } from "@/lib/scenarios/types";
import type { Violation } from "@/lib/policy/violations";
import type { IntegrationVariant } from "@/lib/dashboard/data";

/** Shared server components. Nothing here is interactive, so nothing ships JS. */

export function Tabs({
  active,
  variant,
}: {
  active: "live" | "preflight" | "hamperhub" | "run" | "violations" | "evaluation" | "policy" | "audit";
  variant: IntegrationVariant;
}) {
  const q = `?integration=${variant}`;
  const tabs: Array<{ key: typeof active; href: string; label: string }> = [
    // The merchant comes first: you cannot judge a report about an integration
    // you have not seen.
    // Watching it happen is the fastest way to understand the product.
    { key: "live", href: "/live", label: "Live agent" },
    { key: "preflight", href: "/preflight", label: "Run preflight" },
    { key: "hamperhub", href: "/hamperhub", label: "HamperHub" },
    { key: "run", href: `/${q}`, label: "Run summary" },
    { key: "violations", href: `/violations${q}`, label: "Violations" },
    { key: "evaluation", href: `/evaluation`, label: "Evaluation" },
    { key: "audit", href: `/audit${q}`, label: "Audit trail" },
    { key: "policy", href: `/policy`, label: "Policy" },
  ];
  return (
    <nav className="tabs">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          data-active={String(tab.key === active)}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

export function VariantSwitcher({
  variant,
  basePath,
}: {
  variant: IntegrationVariant;
  basePath: string;
}) {
  return (
    <div className="switcher">
      <Link
        href={`${basePath}?integration=vulnerable`}
        data-active={String(variant === "vulnerable")}
      >
        Vulnerable integration
      </Link>
      <Link
        href={`${basePath}?integration=fixed`}
        data-active={String(variant === "fixed")}
      >
        Fixed integration
      </Link>
    </div>
  );
}

export function Readiness({
  readiness,
  unsafe,
  escapes,
}: {
  readiness: string;
  unsafe: number;
  escapes: number;
}) {
  const ready = readiness === "READY FOR CONTROLLED TEST";
  return (
    <div className={`readiness ${ready ? "ready" : "notready"}`}>
      <span>{ready ? "✓" : "✗"}</span>
      <div>
        {readiness}
        <small>
          {ready
            ? "A readiness report, not a certification — no finite suite proves the absence of defects, which is why the Guard stays active at runtime."
            : `${unsafe} unsafe violation${unsafe === 1 ? "" : "s"}, ${escapes} money-critical escape${escapes === 1 ? "" : "s"}. Fix these before exposing the integration to AI buyers.`}
        </small>
      </div>
    </div>
  );
}

export function DispositionBadge({ value }: { value: JourneyDisposition }) {
  const labels: Record<JourneyDisposition, string> = {
    passed: "passed",
    safely_rejected: "safely rejected",
    escalated: "escalated",
    unsafe_violation: "unsafe violation",
    inconclusive: "inconclusive",
    errored: "errored",
  };
  return <span className={`badge ${value}`}>{labels[value]}</span>;
}

/**
 * Marks who drove a journey.
 *
 * Shown on every journey row on purpose. A reader deserves to know whether an
 * outcome came from a fixed reproduction or from a live model deciding for
 * itself, because the two support very different claims.
 */
export function DriverBadge({ value }: { value: ScenarioDriver }) {
  return value === "agent" ? (
    <span className="driver live" title="A live model chose every tool call.">
      live agent
    </span>
  ) : (
    <span
      className="driver fixed"
      title="A fixed tool sequence, identical on every run."
    >
      fixed repro
    </span>
  );
}

export function ViolationCard({
  violation,
  kind,
  variant,
  scenarioId,
}: {
  violation: Violation;
  kind: "violation" | "escalation";
  variant: IntegrationVariant;
  /** When supplied, links through to that journey's replay. */
  scenarioId?: string;
}) {
  return (
    <div className={`violation ${kind === "escalation" ? "escalation" : ""}`}>
      <div className="top">
        <code>{violation.invariantId}</code>
        <span className={`badge ${violation.severity}`}>
          {violation.severity}
        </span>
        <span className="badge attr">{violation.attribution}</span>
        {violation.moneyAtRiskMinor > 0 && (
          <span className="note">
            at risk {formatMinor(violation.moneyAtRiskMinor)}
          </span>
        )}
        {scenarioId && (
          <Link
            href={`/journey/${encodeURIComponent(scenarioId)}?integration=${variant}`}
            style={{ marginLeft: "auto", fontSize: "0.8rem" }}
          >
            replay {scenarioId} →
          </Link>
        )}
      </div>
      <div className="msg">{violation.message}</div>
      {violation.policyRefs.length > 0 && (
        <div className="fix">
          Policy: {violation.policyRefs.map((r) => <code key={r}>{r} </code>)}
        </div>
      )}
      {violation.remediation && (
        <div className="fix">
          <strong>Fix:</strong> {violation.remediation}
        </div>
      )}
    </div>
  );
}

/**
 * Renders an audit trail with offsets relative to the first event, mirroring the
 * CLI trace. Relative offsets stay stable across reruns, which matters because
 * the same run is re-executed on each request.
 */
export function Trace({ events }: { events: readonly AuditEvent[] }) {
  if (events.length === 0) return <p className="empty">No events recorded.</p>;
  const start = events[0]!.at.getTime();

  return (
    <ul className="trace">
      {events.map((event) => (
        <li key={event.seq} data-decision={event.decision ?? ""}>
          <span className="off mono">{offset(event.at.getTime() - start)}</span>
          <span className="ev">
            <span className="type">{event.type}</span>
            {event.toolName ? <> · <code>{event.toolName}</code></> : null}
            {event.reason ? <div>{event.reason}</div> : null}
            {renderPayload(event)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function renderPayload(event: AuditEvent) {
  const interesting =
    event.type === "quote.created" ||
    event.type === "checkout.requested" ||
    event.type === "checkout.blocked" ||
    event.type === "razorpay.order_created" ||
    event.type === "policy.evaluated" ||
    event.type === "merchant_order.confirmed";
  if (!interesting || !event.output) return null;
  return <pre>{JSON.stringify(event.output, null, 2)}</pre>;
}

function offset(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function ChainStatus({
  ok,
  events,
}: {
  ok: boolean;
  events: number;
}) {
  return (
    <div className={`chain ${ok ? "" : "broken"}`}>
      <span className="dot" />
      <span>
        {ok
          ? `Hash chain verified across ${events} events`
          : "HASH CHAIN BROKEN — the trail has been altered"}
      </span>
    </div>
  );
}

/**
 * Shown when no run exists yet.
 *
 * The report pages deliberately do not start one themselves: with a real model a
 * suite costs minutes and real tokens, so running it is the developer's call.
 */
export function NoRunYet({
  variant,
  what = "preflight run",
}: {
  variant: IntegrationVariant;
  what?: string;
}) {
  return (
    <div className="panel">
      <h2>No {what} yet</h2>
      <p className="note" style={{ marginTop: 0 }}>
        Nothing has been executed for the <strong>{variant}</strong> integration.
        A preflight run drives a real model through every scenario, so it is
        started explicitly rather than on page load.
      </p>
      <Link className="primary link" href={`/preflight?variant=${variant}`}>
        Start a preflight run →
      </Link>
    </div>
  );
}

export function Pct({ value }: { value: number }) {
  return <>{roundPercent(value, 1)}%</>;
}
