import Link from "next/link";
import { formatMinor } from "@/lib/core/money";
import { getSuiteView, type IntegrationVariant } from "@/lib/dashboard/data";
import {
  ChainStatus,
  DispositionBadge,
  Readiness,
  Tabs,
  VariantSwitcher,
} from "./components";

// The engine runs in-process on each request, so this page must not be
// statically prerendered at build time.
export const dynamic = "force-dynamic";

function parseVariant(value: string | undefined): IntegrationVariant {
  return value === "fixed" ? "fixed" : "vulnerable";
}

export default async function RunSummaryPage({
  searchParams,
}: {
  searchParams: Promise<{ integration?: string }>;
}) {
  const params = await searchParams;
  const variant = parseVariant(params.integration);
  const { suite, info } = await getSuiteView(variant);

  const categories = new Map<string, { total: number; unsafe: number }>();
  for (const journey of suite.journeys) {
    const entry = categories.get(journey.category) ?? { total: 0, unsafe: 0 };
    entry.total += 1;
    if (journey.disposition === "unsafe_violation") entry.unsafe += 1;
    categories.set(journey.category, entry);
  }

  return (
    <>
      <Tabs active="run" variant={variant} />
      <VariantSwitcher variant={variant} basePath="/" />

      <div className="panel">
        <h2>AgentProof Preflight Report</h2>
        <div className="meta">
          <div>
            <span>Integration</span>HamperHub Agent Checkout
          </div>
          <div>
            <span>Policy version</span>
            <code>{info.policyVersion}</code>
          </div>
          <div>
            <span>Journeys</span>
            {info.regressionCount} regression + {info.generatedCount} AI-generated
          </div>
          <div>
            <span>Scenario generator</span>
            {info.generatorModel}
            {info.generatorIsReal ? "" : " (deterministic)"}
          </div>
          <div>
            <span>Payment adapter</span>
            {info.paymentAdapter}
          </div>
          <div>
            <span>Seeded defects</span>
            {suite.mutations.length > 0 ? suite.mutations.join(", ") : "none"}
          </div>
        </div>
      </div>

      <div className="panel">
        <Readiness
          readiness={suite.readiness}
          unsafe={suite.unsafeViolations}
          escapes={suite.moneyCriticalEscapes}
        />
      </div>

      <div className="panel">
        <h2>Outcomes</h2>
        <div className="stats">
          <div className="stat ok">
            <div className="n">{suite.passed}</div>
            <div className="k">Passed</div>
          </div>
          <div className="stat">
            <div className="n">{suite.safelyRejected}</div>
            <div className="k">Safely rejected</div>
          </div>
          <div className="stat warn">
            <div className="n">{suite.escalated}</div>
            <div className="k">Escalated</div>
          </div>
          <div className="stat bad">
            <div className="n">{suite.unsafeViolations}</div>
            <div className="k">Unsafe violations</div>
          </div>
          <div className="stat bad">
            <div className="n">{suite.moneyCriticalEscapes}</div>
            <div className="k">Money escapes</div>
          </div>
          <div className="stat info">
            <div className="n">{formatMinor(suite.moneyAtRiskMinor)}</div>
            <div className="k">At risk, prevented</div>
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="panel">
          <h2>Coverage by category</h2>
          <div className="kv">
            {[...categories.entries()].sort().map(([category, entry]) => (
              <div key={category}>
                <span>{category.replace(/_/g, " ")}</span>
                <span>
                  {entry.total} journeys
                  {entry.unsafe > 0 ? ` · ${entry.unsafe} unsafe` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="panel">
          <h2>Integrity</h2>
          <ChainStatus
            ok={suite.auditChainOk}
            events={suite.journeys.reduce((s, j) => s + j.auditEvents, 0)}
          />
          <div className="kv" style={{ marginTop: "0.75rem" }}>
            <div>
              <span>Run duration</span>
              <span>{suite.durationMs}ms</span>
            </div>
            <div>
              <span>Errored journeys</span>
              <span>{suite.errored}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Journeys</h2>
        <table>
          <thead>
            <tr>
              <th>Scenario</th>
              <th>Category</th>
              <th>Outcome</th>
              <th>Invariants fired</th>
              <th className="num">At risk</th>
            </tr>
          </thead>
          <tbody>
            {suite.journeys.map((journey) => (
              <tr key={journey.scenarioId}>
                <td>
                  <Link
                    href={`/journey/${encodeURIComponent(journey.scenarioId)}?integration=${variant}`}
                  >
                    <code>{journey.scenarioId}</code>
                  </Link>
                  <div className="note">{journey.title}</div>
                </td>
                <td className="note">{journey.category.replace(/_/g, " ")}</td>
                <td>
                  <DispositionBadge value={journey.disposition} />
                </td>
                <td className="mono note">
                  {journey.firedInvariants.length > 0
                    ? journey.firedInvariants.join(", ")
                    : "—"}
                </td>
                <td className="num note">
                  {journey.moneyAtRiskMinor > 0
                    ? formatMinor(journey.moneyAtRiskMinor)
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
