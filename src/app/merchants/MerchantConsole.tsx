"use client";

import { useRef, useState } from "react";

/**
 * A third-party catalogue, mapped by a model, then actually tested.
 *
 * What was here before ran two hardcoded journeys — fixed product ids, fixed tool order —
 * and displayed the result as though a merchant had been tested. It had not been. The
 * inferred mapping was never used for anything except agreeing with the hand-written one on
 * that same script, so the two features that mattered never met.
 *
 * This runs the whole claim in one pass: read one response from the merchant, let a model
 * write the mapping, refuse it if validation cannot verify it, browse the catalogue through
 * it, then put real agents in front of the shop and judge them with the same twelve
 * invariants and the same readiness rule HamperHub is judged by.
 *
 * Streamed, because that takes minutes. Every journey appears as it finishes rather than
 * after the whole run, which also means a run that dies halfway still shows what it learned.
 */

interface CapabilityRow {
  capability: string;
  description: string;
  available: boolean;
  derived: boolean;
}

interface Product {
  id: string;
  name: string;
  price: string;
  stock: number;
  vegan: boolean | null;
  allergens: string[] | null;
  category: string;
}

interface Journey {
  index: number;
  total: number;
  id: string;
  title: string;
  model: string | null;
  disposition: string;
  note: string;
  fired: string[];
  withheld: string[];
  moneyAtRisk: string;
  toolPath: string[];
}

interface Summary {
  journeys: number;
  passed: number;
  safelyRejected: number;
  escalated: number;
  unsafeViolations: number;
  inconclusive: number;
  errored: number;
  moneyAtRisk: string;
  readiness: string;
  auditChainOk: boolean;
  durationMs: number;
  withheld: string[];
}

interface Mapping {
  paths: Record<string, string | null>;
  priceForReview: string;
  notes: string;
  capabilities: CapabilityRow[];
  capabilityCount: number;
  capabilityTotal: number;
}

const TONE: Record<string, string> = {
  passed: "ok",
  safely_rejected: "neutral",
  escalated: "warn",
  unsafe_violation: "blocked",
  inconclusive: "warn",
  errored: "blocked",
};

export function MerchantConsole() {
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const [roles, setRoles] = useState<{ adversary: string | null; buyers: string[] } | null>(
    null,
  );
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [catalogue, setCatalogue] = useState<Product[] | null>(null);
  const [assembled, setAssembled] = useState<{
    total: number;
    perturbations: number;
    live: number;
    generated: number;
  } | null>(null);
  const [journeys, setJourneys] = useState<Journey[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [rejected, setRejected] = useState<{ problems: string[]; message: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  function reset() {
    setPhase(null);
    setRoles(null);
    setMapping(null);
    setCatalogue(null);
    setAssembled(null);
    setJourneys([]);
    setCurrent(null);
    setSummary(null);
    setRejected(null);
    setError(null);
  }

  async function run(size: "quick" | "standard") {
    reset();
    setRunning(true);
    const controller = new AbortController();
    abort.current = controller;

    try {
      const response = await fetch(`/api/merchants/run?size=${size}`, {
        method: "POST",
        signal: controller.signal,
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error("no response stream");

      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line; a partial frame stays buffered.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const event = JSON.parse(line.slice(6)) as Record<string, unknown>;

          switch (event.kind) {
            case "start":
              setRoles({
                adversary: (event.adversary as string | null) ?? null,
                buyers: (event.buyers as string[]) ?? [],
              });
              break;
            case "phase":
              setPhase(event.label as string);
              break;
            case "mapping":
              setMapping(event as unknown as Mapping);
              break;
            case "catalogue":
              setCatalogue(event.products as Product[]);
              break;
            case "assembled":
              setAssembled({
                total: event.total as number,
                perturbations: event.perturbations as number,
                live: event.live as number,
                generated: event.generated as number,
              });
              setPhase(null);
              break;
            case "scenario_start":
              setCurrent(`${(event.index as number) + 1}/${event.total} ${event.id}`);
              break;
            case "journey":
              setJourneys((prev) => [...prev, event as unknown as Journey]);
              break;
            case "done":
              setSummary(event.summary as Summary);
              setCurrent(null);
              break;
            case "rejected":
              setRejected({
                problems: event.problems as string[],
                message: event.message as string,
              });
              break;
            case "error":
              setError(event.message as string);
              break;
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setRunning(false);
      setPhase(null);
      setCurrent(null);
      abort.current = null;
    }
  }

  return (
    <>
      <div className="panel">
        <h2>Map this merchant with a model, then test it</h2>
        <p className="lead">
          One response is read from Nordwell&rsquo;s GraphQL API. A model is asked where
          each field lives. Validation accepts the mapping only by building real products
          with it. Then live agents shop the merchant through that mapping and the same
          twelve invariants deliver a verdict. <strong>No product id and no tool order
          appears anywhere in this flow</strong> — the agent finds the shop and decides for
          itself.
        </p>
        <button className="primary" onClick={() => run("standard")} disabled={running}>
          {running ? "Running…" : "Map and test — 20 journeys"}
        </button>{" "}
        <button onClick={() => run("quick")} disabled={running}>
          Quick — 8 journeys
        </button>
        {running && (
          <p className="meta">
            {phase ?? current ?? "Working…"} — each journey is a real multi-turn
            conversation, so this takes minutes.
          </p>
        )}
        {roles && (
          <div className="meta">
            <div>
              <span>Buyers</span>
              <span className="mono">{roles.buyers.join(" · ") || "—"}</span>
            </div>
            <div>
              <span>Adversary</span>
              <span className="mono">{roles.adversary ?? "none"}</span>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="panel">
          <h2>The run stopped</h2>
          <pre className="mono">{error}</pre>
        </div>
      )}

      {rejected && (
        <div className="panel">
          <h2>The model&rsquo;s mapping was refused — nothing ran through it</h2>
          <p className="lead">{rejected.message}</p>
          <ul className="trace">
            {rejected.problems.map((problem, index) => (
              <li key={index} data-tone="blocked">
                {problem}
              </li>
            ))}
          </ul>
        </div>
      )}

      {mapping && (
        <div className="panel">
          <h2>What the model decided, and what it cost us</h2>
          <table>
            <tbody>
              {Object.entries(mapping.paths).map(([field, path]) => (
                <tr key={field}>
                  <td>{field}</td>
                  <td className="mono">{path ?? "not mapped"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="lead">
            Inferred price: <strong>{mapping.priceForReview}</strong> — a human confirms
            this. Nothing in the data distinguishes ₹649.00 from ₹6.49, so the unit is the
            one judgement validation cannot make for you.
          </p>
          {mapping.notes && <p className="meta">Model&rsquo;s notes: {mapping.notes}</p>}
          <h3>
            Capabilities: {mapping.capabilityCount} of {mapping.capabilityTotal}
          </h3>
          <table>
            <tbody>
              {mapping.capabilities.map((row) => (
                <tr key={row.capability}>
                  <td className="mono">{row.capability}</td>
                  <td>
                    {row.available
                      ? row.derived
                        ? "yes — tracked by the engine"
                        : "yes"
                      : "no"}
                  </td>
                  <td className="note">{row.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {catalogue && (
        <div className="panel">
          <h2>The shop, as the agent will see it</h2>
          <p className="lead">
            Browsed through the model&rsquo;s mapping and translated into the entity model.
            The agent picks from this — nobody hands it a basket.
          </p>
          <table>
            <thead>
              <tr>
                <th>Id</th>
                <th>Name</th>
                <th>Price</th>
                <th>Stock</th>
                <th>Vegan</th>
                <th>Allergens</th>
              </tr>
            </thead>
            <tbody>
              {catalogue.map((product) => (
                <tr key={product.id}>
                  <td className="mono">{product.id}</td>
                  <td>{product.name}</td>
                  <td>{product.price}</td>
                  <td>{product.stock}</td>
                  <td>{product.vegan === null ? "unknown" : String(product.vegan)}</td>
                  <td>
                    {product.allergens === null
                      ? "unknown"
                      : product.allergens.length === 0
                        ? "none declared"
                        : product.allergens.join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(assembled || journeys.length > 0) && (
        <div className="panel">
          <h2>
            Journeys{assembled ? ` (${journeys.length}/${assembled.total})` : ""}
          </h2>
          {assembled && (
            <p className="meta">
              {assembled.perturbations} transport perturbation · {assembled.live} live goal
              · {assembled.generated} written by the adversary
            </p>
          )}
          <table>
            <thead>
              <tr>
                <th>Scenario</th>
                <th>Driven by</th>
                <th>Outcome</th>
                <th>Invariants fired</th>
                <th>At risk</th>
              </tr>
            </thead>
            <tbody>
              {journeys.map((journey) => (
                <tr key={`${journey.id}-${journey.index}`} data-tone={TONE[journey.disposition]}>
                  <td>
                    <div className="mono">{journey.id}</div>
                    <div className="note">{journey.title}</div>
                    {journey.toolPath.length > 0 && (
                      <div className="note mono" style={{ fontSize: "0.7rem" }}>
                        {journey.toolPath.join(" → ")}
                      </div>
                    )}
                  </td>
                  <td className="mono note">{journey.model ?? "—"}</td>
                  <td>
                    {journey.disposition}
                    <div className="note">{journey.note}</div>
                  </td>
                  <td className="mono note">{journey.fired.join(", ") || "—"}</td>
                  <td>{journey.moneyAtRisk}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {current && <p className="meta">Running {current}…</p>}
        </div>
      )}

      {summary && (
        <div className="panel">
          <h2>Verdict on a merchant nobody hardcoded</h2>
          <div className="meta">
            <div>
              <span>Readiness</span>
              <strong>{summary.readiness}</strong>
            </div>
            <div>
              <span>Journeys</span>
              {summary.journeys}
            </div>
            <div>
              <span>Passed</span>
              {summary.passed}
            </div>
            <div>
              <span>Safely rejected</span>
              {summary.safelyRejected}
            </div>
            <div>
              <span>Escalated</span>
              {summary.escalated}
            </div>
            <div>
              <span>Unsafe violations</span>
              {summary.unsafeViolations}
            </div>
            <div>
              <span>Inconclusive</span>
              {summary.inconclusive}
            </div>
            <div>
              <span>Money at risk</span>
              {summary.moneyAtRisk}
            </div>
            <div>
              <span>Audit chain</span>
              {summary.auditChainOk ? "intact" : "BROKEN"}
            </div>
            <div>
              <span>Duration</span>
              {Math.round(summary.durationMs / 1000)}s
            </div>
          </div>
          {/*
            The denominator, stated. "No unsafe violations" across eleven rules is a
            different claim from the same result across twelve, and only this line tells
            them apart.
          */}
          <p className="lead" style={{ marginBottom: 0 }}>
            {summary.withheld.length > 0
              ? `Judged on ${12 - summary.withheld.length} of 12 invariants. ` +
                `${summary.withheld.join(", ")} could not run against this merchant and ` +
                `is reported as not run, never counted as a pass it did not earn.`
              : "All twelve invariants ran against this merchant."}
          </p>
          {summary.readiness === "INCONCLUSIVE" && (
            <p className="lead">
              <strong>Inconclusive, not clean.</strong> No defects were found and not
              enough was verified to call that a result — either no invariant was
              exercised, or most journeys ended without deciding anything. A green tick
              here would be the exact false assurance this engine exists to prevent.
            </p>
          )}
          {summary.inconclusive > 0 && (
            <p className="meta">
              {summary.inconclusive} journey(s) ended inconclusive — the agent ran out of
              tool budget or declined to proceed, so nothing was verified. Excluded from
              coverage rather than counted as safe.
            </p>
          )}
        </div>
      )}
    </>
  );
}
