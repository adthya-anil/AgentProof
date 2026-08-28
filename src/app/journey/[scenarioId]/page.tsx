import Link from "next/link";
import { notFound } from "next/navigation";
import { formatMinor } from "@/lib/core/money";
import { getJourney, type IntegrationVariant } from "@/lib/dashboard/data";
import {
  ChainStatus,
  DispositionBadge,
  DriverBadge,
  Tabs,
  Trace,
  ViolationCard,
} from "../../components";

export const dynamic = "force-dynamic";

function parseVariant(value: string | undefined): IntegrationVariant {
  return value === "fixed" ? "fixed" : "vulnerable";
}

/**
 * Journey replay.
 *
 * Shows buyer intent, every tool call, state changes, policy evaluation and the
 * exact failed invariant — concise decision explanations, never model reasoning.
 */
export default async function JourneyPage({
  params,
  searchParams,
}: {
  params: Promise<{ scenarioId: string }>;
  searchParams: Promise<{ integration?: string }>;
}) {
  const [{ scenarioId }, query] = await Promise.all([params, searchParams]);
  const variant = parseVariant(query.integration);
  const journey = await getJourney(variant, decodeURIComponent(scenarioId));

  if (!journey) notFound();

  const intentEvent = journey.auditTrail.find(
    (e) => e.type === "intent.received",
  );
  const utterance =
    intentEvent && typeof intentEvent.input === "object" && intentEvent.input
      ? (intentEvent.input as { utterance?: string }).utterance
      : undefined;

  return (
    <>
      <Tabs active="run" variant={variant} />
      <Link className="back" href={`/?integration=${variant}`}>
        ← back to run summary
      </Link>

      <div className="panel">
        <h2>{journey.scenarioId}</h2>
        <div style={{ marginBottom: "0.85rem" }}>
          <strong>{journey.title}</strong>
        </div>
        {utterance && (
          <blockquote
            style={{
              margin: "0 0 0.9rem",
              paddingLeft: "0.85rem",
              borderLeft: "3px solid var(--border)",
              color: "var(--muted)",
              fontSize: "0.9rem",
            }}
          >
            “{utterance}”
          </blockquote>
        )}
        <div className="meta">
          <div>
            <span>Outcome</span>
            <DispositionBadge value={journey.disposition} />
          </div>
          <div>
            <span>Driven by</span>
            <DriverBadge value={journey.driver} />
          </div>
          {journey.model && (
            <div>
              <span>Model</span>
              <code>{journey.model}</code>
            </div>
          )}
          <div>
            <span>Category</span>
            {journey.category.replace(/_/g, " ")}
          </div>
          <div>
            <span>Money at risk</span>
            {formatMinor(journey.moneyAtRiskMinor)}
          </div>
          <div>
            <span>Provider orders</span>
            {journey.providerOrders}
          </div>
          <div>
            <span>Duplicate payable orders</span>
            {journey.duplicatePayableOrders}
          </div>
          <div>
            <span>Self-rejected by merchant</span>
            {journey.selfRejected ? "yes" : "no"}
          </div>
        </div>
        <p className="note" style={{ marginBottom: 0 }}>
          {journey.note}
        </p>
      </div>

      {journey.error && (
        <div className="panel">
          <h2>Error</h2>
          <pre>{journey.error}</pre>
        </div>
      )}

      {journey.violations.length > 0 && (
        <div className="panel">
          <h2>Violations</h2>
          {journey.violations.map((violation) => (
            <ViolationCard
              key={violation.id}
              violation={violation}
              kind="violation"
              variant={variant}
            />
          ))}
        </div>
      )}

      {journey.escalations.length > 0 && (
        <div className="panel">
          <h2>Escalations</h2>
          {journey.escalations.map((violation) => (
            <ViolationCard
              key={violation.id}
              violation={violation}
              kind="escalation"
              variant={variant}
            />
          ))}
        </div>
      )}

      <div className="panel">
        <h2>Replay</h2>
        <Trace events={journey.auditTrail} />
        <div style={{ marginTop: "1rem" }}>
          <ChainStatus ok={journey.auditChainOk} events={journey.auditEvents} />
        </div>
      </div>
    </>
  );
}
