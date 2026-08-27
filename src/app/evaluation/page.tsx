import Link from "next/link";
import { getEvaluationSummary } from "@/lib/dashboard/data";
import { Pct, Tabs } from "../components";

export const dynamic = "force-dynamic";

/**
 * Mutation evaluation (§17).
 *
 * Each defect is scored in isolation, which is standard mutation-testing
 * practice and the honest way to report recall: with several defects active an
 * upstream block can mask a downstream one.
 */
export default async function EvaluationPage() {
  const summary = await getEvaluationSummary();

  return (
    <>
      <Tabs active="evaluation" variant="vulnerable" />

      <div className="panel">
        <h2>Detection metrics</h2>
        <div className="stats">
          <div className="stat ok">
            <div className="n">
              {summary.detected}/{summary.total}
            </div>
            <div className="k">Defects detected</div>
          </div>
          <div className="stat ok">
            <div className="n">
              <Pct value={summary.recallPercent} />
            </div>
            <div className="k">Detection recall</div>
          </div>
          <div
            className={`stat ${summary.falsePositives === 0 ? "ok" : "bad"}`}
          >
            <div className="n">
              <Pct value={summary.falsePositivePercent} />
            </div>
            <div className="k">False-positive rate</div>
          </div>
          <div className={`stat ${summary.escapes === 0 ? "ok" : "bad"}`}>
            <div className="n">{summary.escapes}</div>
            <div className="k">Escaped the Guard</div>
          </div>
        </div>
        <p className="note" style={{ marginBottom: 0, marginTop: "0.9rem" }}>
          False positives are measured on the <strong>fixed</strong> integration:{" "}
          {summary.falsePositives} of {summary.falsePositiveTotal} journeys were
          flagged as an integration defect when there was no defect to find.
        </p>
      </div>

      <div className="panel">
        <h2>Seeded defects, one mutant at a time</h2>
        <table>
          <thead>
            <tr>
              <th />
              <th>Mutation</th>
              <th>Expected invariant</th>
              <th>Fired</th>
              <th>Scenario</th>
            </tr>
          </thead>
          <tbody>
            {summary.scores.map((score) => (
              <tr key={score.mutation}>
                <td style={{ color: score.detected ? "var(--ok)" : "var(--bad)" }}>
                  {score.detected ? "✓" : "✗"}
                </td>
                <td>
                  <code>{score.mutation}</code>
                  <div className="note">{score.title}</div>
                </td>
                <td className="mono note">{score.expectedInvariant}</td>
                <td className="mono note">
                  {score.detectedBy.length > 0
                    ? score.detectedBy.join(", ")
                    : "—"}
                </td>
                <td>
                  <Link
                    href={`/journey/${encodeURIComponent(score.scenarioId)}?integration=vulnerable`}
                  >
                    <code>{score.scenarioId}</code>
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h2>Why one at a time</h2>
        <p className="note" style={{ marginTop: 0 }}>
          Mutation masking is real and we measure around it rather than hide it.
          With every defect active at once,{" "}
          <code>missing_quote_expiry</code> issues 24-hour quotes, so{" "}
          <code>INV-QUOTE-EXPIRY</code> blocks at approval and the journey never
          reaches checkout — meaning the price-binding defect downstream is never
          exercised. Averaging that in would understate recall, so each mutant is
          scored on its own, and the masking behaviour has its own test.
        </p>
      </div>
    </>
  );
}
