import Link from "next/link";
import { getSuiteView, type IntegrationVariant } from "@/lib/dashboard/data";
import { ChainStatus, NoRunYet, Tabs, VariantSwitcher } from "../components";

export const dynamic = "force-dynamic";

function parseVariant(value: string | undefined): IntegrationVariant {
  return value === "fixed" ? "fixed" : "vulnerable";
}

/**
 * Runtime audit view.
 *
 * The money-critical decisions across every journey in one place, so a reviewer
 * can confirm that each blocked checkout took no financial action.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ integration?: string }>;
}) {
  const params = await searchParams;
  const variant = parseVariant(params.integration);
  const view = getSuiteView(variant);

  if (!view) {
    return (
      <>
        <Tabs active="audit" variant={variant} />
        <VariantSwitcher variant={variant} basePath="/audit" />
        <NoRunYet variant={variant} />
      </>
    );
  }
  const { suite } = view;

  const decisions = suite.journeys.flatMap((journey) =>
    journey.auditTrail
      .filter(
        (event) =>
          event.type === "checkout.blocked" ||
          event.type === "razorpay.order_created" ||
          event.type === "merchant_order.confirmed" ||
          event.type === "payment.verified" ||
          event.type === "payment.failed" ||
          event.type === "catalog.state_changed",
      )
      .map((event) => ({ journey, event })),
  );

  const totalEvents = suite.journeys.reduce((s, j) => s + j.auditEvents, 0);
  const orders = decisions.filter(
    (d) => d.event.type === "razorpay.order_created",
  ).length;
  const blocked = decisions.filter(
    (d) => d.event.type === "checkout.blocked",
  ).length;
  const confirmed = decisions.filter(
    (d) => d.event.type === "merchant_order.confirmed",
  ).length;

  return (
    <>
      <Tabs active="audit" variant={variant} />
      <VariantSwitcher variant={variant} basePath="/audit" />

      <div className="panel">
        <h2>Audit integrity</h2>
        <ChainStatus ok={suite.auditChainOk} events={totalEvents} />
        <p className="note" style={{ marginBottom: 0, marginTop: "0.75rem" }}>
          Every event&apos;s hash covers its own canonical content plus the
          previous hash, so altering or deleting any historical event invalidates
          every hash after it. That is what makes this replay trustworthy rather
          than merely plausible.
        </p>
      </div>

      <div className="panel">
        <h2>Money-critical decisions</h2>
        <div className="stats">
          <div className="stat">
            <div className="n">{orders}</div>
            <div className="k">Payable orders created</div>
          </div>
          <div className="stat warn">
            <div className="n">{blocked}</div>
            <div className="k">Checkouts blocked</div>
          </div>
          <div className="stat ok">
            <div className="n">{confirmed}</div>
            <div className="k">Orders confirmed</div>
          </div>
          <div className="stat bad">
            <div className="n">{suite.moneyCriticalEscapes}</div>
            <div className="k">Escapes</div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Decision log ({decisions.length})</h2>
        {decisions.length === 0 ? (
          <p className="empty">No money-critical events recorded.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Journey</th>
                <th>Decision</th>
                <th>Reason</th>
                <th>Financial action</th>
              </tr>
            </thead>
            <tbody>
              {decisions.map(({ journey, event }) => {
                const output = (event.output ?? {}) as Record<string, unknown>;
                const action =
                  event.type === "checkout.blocked"
                    ? String(output.financial_action_taken ?? "none")
                    : event.type === "razorpay.order_created"
                      ? `order ${event.providerOrderId ?? ""}`
                      : event.type === "merchant_order.confirmed"
                        ? `confirmed ₹${String(output.amount ?? "")}`
                        : "—";
                return (
                  <tr key={`${journey.scenarioId}-${event.seq}`}>
                    <td className="mono">{event.type}</td>
                    <td>
                      <Link
                        href={`/journey/${encodeURIComponent(journey.scenarioId)}?integration=${variant}`}
                      >
                        <code>{journey.scenarioId}</code>
                      </Link>
                    </td>
                    <td>
                      {event.decision ? (
                        <span
                          className={`badge ${
                            event.decision === "block"
                              ? "unsafe_violation"
                              : event.decision === "escalate"
                                ? "escalated"
                                : "passed"
                          }`}
                        >
                          {event.decision}
                        </span>
                      ) : (
                        <span className="note">—</span>
                      )}
                    </td>
                    <td className="note">{event.reason ?? "—"}</td>
                    <td className="note">{action}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
