import { formatMinor } from "@/lib/core/money";
import { getSuiteView, type IntegrationVariant } from "@/lib/dashboard/data";
import { NoRunYet, Tabs, ViolationCard, VariantSwitcher } from "../components";

export const dynamic = "force-dynamic";

function parseVariant(value: string | undefined): IntegrationVariant {
  return value === "fixed" ? "fixed" : "vulnerable";
}

export default async function ViolationsPage({
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
        <Tabs active="violations" variant={variant} />
        <VariantSwitcher variant={variant} basePath="/violations" />
        <NoRunYet variant={variant} />
      </>
    );
  }
  const { suite } = view;

  const defects = suite.journeys.flatMap((journey) =>
    journey.integrationDefects.map((violation) => ({ journey, violation })),
  );
  // Everything the Guard raised that is *not* an integration defect. Derived by
  // difference rather than by re-filtering on attribution, so no finding can
  // fall between the two buckets and quietly disappear from the report.
  const contained = suite.journeys.flatMap((journey) => {
    const defectIds = new Set(journey.integrationDefects.map((v) => v.id));
    return journey.violations
      .filter((v) => !defectIds.has(v.id))
      .map((violation) => ({ journey, violation }));
  });
  const escalations = suite.journeys.flatMap((journey) =>
    journey.escalations.map((violation) => ({ journey, violation })),
  );

  return (
    <>
      <Tabs active="violations" variant={variant} />
      <VariantSwitcher variant={variant} basePath="/violations" />

      <div className="panel">
        <h2>Integration defects ({defects.length})</h2>
        <p className="note" style={{ marginTop: 0 }}>
          Findings attributed to the code under test: the integration would have
          let money move incorrectly and did not catch it itself. These are the
          ones a developer must fix.
        </p>
        {defects.length === 0 ? (
          <p className="empty">
            None. No journey found a case where the integration would have
            allowed an unsafe transaction.
          </p>
        ) : (
          defects.map(({ journey, violation }) => (
            <ViolationCard
              key={`${journey.scenarioId}-${violation.id}`}
              violation={violation}
              kind="violation"
              variant={variant}
              scenarioId={journey.scenarioId}
            />
          ))
        )}
      </div>

      <div className="panel">
        <h2>Contained, not a merchant defect ({contained.length})</h2>
        <p className="note" style={{ marginTop: 0 }}>
          Findings where responsibility lies elsewhere: an agent overspending a
          stated budget, a mid-flight price or stock change, or a case the
          merchant&apos;s own code already rejected — where the Guard&apos;s
          verdict merely concurs. The system working as intended, so these are not
          scored against the integration.
        </p>
        {contained.length === 0 ? (
          <p className="empty">Nothing in this category.</p>
        ) : (
          contained.map(({ journey, violation }) => (
            <ViolationCard
              key={`${journey.scenarioId}-${violation.id}`}
              violation={violation}
              kind="escalation"
              variant={variant}
              scenarioId={journey.scenarioId}
            />
          ))
        )}
      </div>

      <div className="panel">
        <h2>Escalated for human approval ({escalations.length})</h2>
        <p className="note" style={{ marginTop: 0 }}>
          Policy declined to decide automatically. A safe outcome, not a defect —
          most often missing product-safety data, which can never be read as safe.
        </p>
        {escalations.length === 0 ? (
          <p className="empty">Nothing escalated.</p>
        ) : (
          escalations.map(({ journey, violation }) => (
            <ViolationCard
              key={`${journey.scenarioId}-${violation.id}`}
              violation={violation}
              kind="escalation"
              variant={variant}
              scenarioId={journey.scenarioId}
            />
          ))
        )}
      </div>

      <div className="panel">
        <h2>Total exposure prevented</h2>
        <div className="stats">
          <div className="stat info">
            <div className="n">{formatMinor(suite.moneyAtRiskMinor)}</div>
            <div className="k">Money at risk</div>
          </div>
          <div className="stat bad">
            <div className="n">{suite.moneyCriticalEscapes}</div>
            <div className="k">Escaped the Guard</div>
          </div>
        </div>
      </div>
    </>
  );
}
