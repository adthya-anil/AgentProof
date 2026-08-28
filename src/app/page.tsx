import Link from "next/link";
import { formatMinor } from "@/lib/core/money";
import { getSuiteView, type IntegrationVariant } from "@/lib/dashboard/data";
import {
  ChainStatus,
  DispositionBadge,
  DriverBadge,
  NoRunYet,
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
  const view = await getSuiteView(variant);

  if (!view) {
    return (
      <>
        <Tabs active="run" variant={variant} />
        <VariantSwitcher variant={variant} basePath="/" />
        <NoRunYet variant={variant} />
      </>
    );
  }
  const { suite, info } = view;

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
            {info.regressionCount} regression + {info.perturbationCount}{" "}
            perturbation + {info.liveCount} live-agent replay +{" "}
            {info.generatedCount} AI-generated
          </div>
          <div>
            <span>Driven by a live model</span>
            {suite.agentDriven} of {suite.journeys.length} journeys
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
          <div className="stat">
            <div className="n">{suite.inconclusive}</div>
            <div className="k">Inconclusive</div>
          </div>
          <div className="stat info">
            <div className="n">{formatMinor(suite.moneyAtRiskMinor)}</div>
            <div className="k">At risk, prevented</div>
          </div>
        </div>
        {suite.inconclusive > 0 && (
          <p className="note" style={{ marginBottom: 0 }}>
            Inconclusive journeys are live-agent runs that ended without anything
            deciding them — an exhausted tool budget or a model failure. They are
            counted separately rather than as safe rejections, because they
            verified nothing.
          </p>
        )}
      </div>

      {suite.byModel.length > 1 && (
        <div className="panel">
          <h2>{info.adversaryModel ? "What each model did" : "Where the models differ"}</h2>
          {/*
            The stored report has to describe its own methodology, which is why
            adversaryModel is persisted alongside the run. Guessing was not an option:
            the previous text asserted a cross-product that a split run never performs.
          */}
          <p className="note" style={{ marginTop: 0 }}>
            {info.adversaryModel ? (
              <>
                <span className="mono">{info.adversaryModel}</span> was given the
                adversary role and wrote the goals, so it only drove the journeys it
                invented; every other live goal went to the buyer. The models did
                different jobs on different scenarios, so this is a breakdown by
                role — <strong>not</strong> a comparison. A row with fewer unsafe
                violations is not a safer agent, it is a smaller and different set of
                journeys.
              </>
            ) : (
              <>
                Every live goal was attempted by each model, because a merchant does
                not get to choose which agent shops their store. Rows that disagree
                show how much this integration is leaning on the agent&apos;s own
                judgement instead of its own checks.
              </>
            )}
          </p>
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th className="num">Journeys</th>
                <th className="num">Passed</th>
                <th className="num">Unsafe</th>
                <th className="num">Inconclusive</th>
                <th>Invariants tripped</th>
              </tr>
            </thead>
            <tbody>
              {suite.byModel.map((entry) => (
                <tr key={entry.model}>
                  <td className="mono">{entry.model}</td>
                  <td className="num">{entry.journeys}</td>
                  <td className="num">{entry.passed}</td>
                  <td
                    className="num"
                    style={{
                      color: entry.unsafeViolations > 0 ? "var(--bad)" : undefined,
                    }}
                  >
                    {entry.unsafeViolations}
                  </td>
                  <td className="num note">{entry.inconclusive}</td>
                  <td className="mono note" style={{ fontSize: "0.72rem" }}>
                    {entry.firedInvariants.length > 0
                      ? entry.firedInvariants.join(", ")
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
              <th>Driven by</th>
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
                <td>
                  <DriverBadge value={journey.driver} />
                  {journey.model && (
                    <div className="note mono" style={{ fontSize: "0.7rem" }}>
                      {journey.model}
                    </div>
                  )}
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
