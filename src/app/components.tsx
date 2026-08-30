import Link from "next/link";
import { Fragment } from "react";
import type { AuditEvent } from "@/lib/audit/events";
import { formatMinor, roundPercent } from "@/lib/core/money";
import type { JourneyDisposition } from "@/lib/runner/run";
import type { ScenarioDriver } from "@/lib/scenarios/types";
import type { Violation } from "@/lib/policy/violations";
import type { IntegrationVariant } from "@/lib/dashboard/data";

/** Shared server components. Nothing here is interactive, so nothing ships JS. */

type NavKey =
  | "live"
  | "preflight"
  | "hamperhub"
  | "merchants"
  | "run"
  | "violations"
  | "evaluation"
  | "policy"
  | "audit";

function NavIcon({ name }: { name: NavKey }) {
  const paths: Record<NavKey, React.ReactNode> = {
    live: <path d="M3 12h3l2.2-5 3.5 10 2.5-6H21" />,
    hamperhub: (
      <>
        <path d="M4 10v10h16V10M3 10l2-6h14l2 6" />
        <path d="M8 20v-6h8v6" />
      </>
    ),
    preflight: (
      <>
        <path d="m12 3-7.5 3v5.2c0 4.7 3.1 8.1 7.5 9.8 4.4-1.7 7.5-5.1 7.5-9.8V6L12 3Z" />
        <path d="m8.7 12 2.1 2.1 4.6-4.7" />
      </>
    ),
    merchants: (
      <>
        <circle cx="6" cy="7" r="2.5" />
        <circle cx="18" cy="7" r="2.5" />
        <circle cx="12" cy="17" r="2.5" />
        <path d="m8.2 8.2 2.6 6.4m5-6.4-2.6 6.4M8.5 7h7" />
      </>
    ),
    run: (
      <>
        <rect x="3.5" y="4" width="17" height="16" rx="2" />
        <path d="M8 15v2m4-6v6m4-9v9" />
      </>
    ),
    violations: (
      <>
        <path d="M12 3 2.8 20h18.4L12 3Z" />
        <path d="M12 9v5m0 3h.01" />
      </>
    ),
    evaluation: (
      <>
        <path d="M4 19V9m6 10V5m6 14v-7m4 7H2" />
        <path d="m4 7 6-4 6 6 4-3" />
      </>
    ),
    audit: (
      <>
        <path d="M9 6h11M9 12h11M9 18h11" />
        <path d="m3.5 6 .8.8L6 5m-2.5 7 .8.8L6 11m-2.5 7 .8.8L6 17" />
      </>
    ),
    policy: (
      <>
        <path d="M6 3h9l4 4v14H6V3Z" />
        <path d="M15 3v5h4M9 12h6m-6 4h6" />
      </>
    ),
  };

  return (
    <svg
      className="nav-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}

export function Tabs({
  active,
  variant,
}: {
  active: NavKey;
  variant: IntegrationVariant;
}) {
  const q = `?integration=${variant}`;

  const groups: Array<{
    label: string;
    items: Array<{
      key: NavKey;
      href: string;
      label: string;
      icon: NavKey;
    }>;
  }> = [
    {
      label: "Watch",
      items: [
        { key: "live", href: "/live", label: "Live agent", icon: "live" },
        {
          key: "hamperhub",
          href: "/hamperhub",
          label: "HamperHub store",
          icon: "hamperhub",
        },
      ],
    },
    {
      label: "Test",
      items: [
        {
          key: "preflight",
          href: "/preflight",
          label: "Run preflight",
          icon: "preflight",
        },
        {
          key: "merchants",
          href: `/merchants${q}`,
          label: "Any merchant",
          icon: "merchants",
        },
      ],
    },
    {
      label: "Results",
      items: [
        { key: "run", href: `/${q}`, label: "Run summary", icon: "run" },
        {
          key: "violations",
          href: `/violations${q}`,
          label: "Violations",
          icon: "violations",
        },
        {
          key: "evaluation",
          href: "/evaluation",
          label: "Evaluation",
          icon: "evaluation",
        },
        {
          key: "audit",
          href: `/audit${q}`,
          label: "Audit trail",
          icon: "audit",
        },
      ],
    },
    {
      label: "Reference",
      items: [{ key: "policy", href: "/policy", label: "Policy", icon: "policy" }],
    },
  ];

  return (
    <nav className="tabs" aria-label="Sections">
      {groups.map((group) => (
        <Fragment key={group.label}>
          <span className="group">{group.label}</span>
          {group.items.map((tab) => (
            <Link
              key={tab.key}
              href={tab.href}
              data-active={String(tab.key === active)}
              aria-current={tab.key === active ? "page" : undefined}
            >
              <NavIcon name={tab.icon} />
              <span>{tab.label}</span>
            </Link>
          ))}
        </Fragment>
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
        aria-current={variant === "vulnerable" ? "page" : undefined}
      >
        Vulnerable integration
      </Link>
      <Link
        href={`${basePath}?integration=fixed`}
        data-active={String(variant === "fixed")}
        aria-current={variant === "fixed" ? "page" : undefined}
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
  /**
   * Three states, because inconclusive is not a failure.
   *
   * A boolean here would render "we could not tell" with the same red cross as "we found
   * defects", which are opposite claims: one is a finding about the integration, the other
   * is the absence of one. Marking thin evidence as a failure would push a reader to go
   * looking for a bug that no journey reported.
   */
  const ready = readiness === "READY FOR CONTROLLED TEST";
  const inconclusive = readiness === "INCONCLUSIVE";
  return (
    <div
      className={`readiness ${ready ? "ready" : inconclusive ? "inconclusive" : "notready"}`}
    >
      <span>{ready ? "✓" : inconclusive ? "?" : "✗"}</span>
      <div>
        {readiness}
        <small>
          {ready
            ? "A readiness report, not a certification — no finite suite proves the absence of defects, which is why the Guard stays active at runtime."
            : inconclusive
              ? "No defects were found, and not enough was verified to call that a result. Either no invariant was exercised or most journeys ended without deciding anything — so this says nothing about the integration either way."
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
            className="replay-link"
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

/**
 * Event types whose payload adds nothing a reader needs.
 *
 * Deliberately a denylist. This was a whitelist of "interesting" types, which meant
 * every event added later had its detail silently dropped — `catalog.state_changed`
 * appeared with its reason but not the 599 → 649 that made it meaningful, and
 * `run.completed` appeared without the verdict it exists to carry. A reader had no
 * way to tell a payload that was empty from one that was withheld.
 *
 * Inverted, the default is to show the record. Anything hidden has to be argued for
 * here, and a new event type cannot lose its detail by nobody remembering to add it.
 */
const PAYLOAD_NOT_WORTH_SHOWING = new Set<AuditEvent["type"]>([
  // The arguments are already rendered from `input` on the request itself.
  "agent.tool_requested",
  // A bare acknowledgement; the interesting part is the policy verdict that follows.
  "tool.executed",
]);

function renderPayload(event: AuditEvent) {
  if (PAYLOAD_NOT_WORTH_SHOWING.has(event.type) || !event.output) return null;
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
      <p className="note no-run-copy">
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
