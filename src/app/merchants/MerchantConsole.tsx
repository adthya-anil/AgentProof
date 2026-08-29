"use client";

import { useState } from "react";

/**
 * Runs the twelve invariants against Nordwell and shows what happened.
 *
 * On demand rather than on page load. The run makes real HTTP calls to a second
 * merchant and re-prices its catalogue, and a page that did that on every visit would
 * be doing surprising work for anyone who merely navigated here.
 */

interface CapabilityRow {
  capability: string;
  description: string;
  available: boolean;
  derived: boolean;
}

interface Result {
  ok: boolean;
  error?: string;
  endpoint?: string;
  merchant?: { label: string; transport: string; endpoint: string };
  capabilities?: CapabilityRow[];
  capabilityCount?: number;
  capabilityTotal?: number;
  catalogue?: Array<{
    id: string;
    name: string;
    price: string;
    stock: number;
    vegan: boolean | null;
    allergens: string[] | null;
    category: string;
  }>;
  clean?: {
    steps: Array<{ label: string; detail: string; tone: string }>;
    total: number;
    allowed: boolean;
    violations: number;
    withheld: string[];
  };
  reprice?: {
    quotedAt: number;
    newPrice: number;
    blocked: boolean;
    reason: string | null;
    fired: string[];
  };
}

interface Verdict {
  total: number;
  blocked: boolean;
  fired: string[];
  withheld: string[];
}

interface InferResult {
  ok: boolean;
  reason?: "no-model" | "rejected" | "error";
  error?: string;
  model?: string;
  problems?: string[];
  proposal?: unknown;
  mapping?: Record<string, string | null>;
  priceForReview?: string;
  capabilities?: string[];
  derivedCapabilities?: string[];
  notes?: string;
  handWritten?: Verdict;
  modelWritten?: Verdict;
  agree?: boolean;
}

export function MerchantConsole() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [inferring, setInferring] = useState(false);
  const [inferred, setInferred] = useState<InferResult | null>(null);

  async function infer() {
    setInferring(true);
    setInferred(null);
    try {
      const response = await fetch("/api/merchants/infer", { method: "POST" });
      setInferred((await response.json()) as InferResult);
    } catch (error) {
      setInferred({
        ok: false,
        reason: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setInferring(false);
    }
  }

  async function run() {
    setRunning(true);
    setResult(null);
    try {
      const response = await fetch("/api/merchants", { method: "POST" });
      setResult((await response.json()) as Result);
    } catch (error) {
      setResult({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <div className="panel">
        <h2>Run the same rules against Nordwell</h2>
        <p className="lead">
          Nordwell Provisions is a separate GraphQL service with its own data model,
          reached over HTTP exactly as a third party&rsquo;s catalogue would be. Nothing
          about the twelve invariants changes — only a mapping describing where its
          fields live.
        </p>
        <button className="primary" onClick={run} disabled={running}>
          {running ? "Running…" : "Run against Nordwell"}
        </button>
      </div>

      {result && !result.ok && (
        <div className="panel">
          <h2>Could not reach Nordwell</h2>
          <p className="lead">
            The adapter reaching a merchant is the thing that can break, so the failure
            is shown rather than hidden.
          </p>
          <pre className="mono">{result.error}</pre>
          {result.endpoint && <p className="meta mono">{result.endpoint}</p>}
        </div>
      )}

      {result?.ok && (
        <>
          <div className="panel">
            <h2>What Nordwell can answer</h2>
            <p className="lead">
              Derived from the mapping, not declared beside it: a merchant cannot claim a
              capability without saying which field supplies it.{" "}
              <strong>
                {result.capabilityCount} of {result.capabilityTotal}
              </strong>{" "}
              available.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Capability</th>
                  <th>Available</th>
                  <th>What it means</th>
                </tr>
              </thead>
              <tbody>
                {result.capabilities?.map((row) => (
                  <tr key={row.capability}>
                    <td className="mono">{row.capability}</td>
                    <td>
                      {row.available
                        ? row.derived
                          ? "yes — tracked by the engine"
                          : "yes"
                        : "no"}
                    </td>
                    <td>{row.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="meta">
              &ldquo;Tracked by the engine&rdquo; means Nordwell has no such field and
              the engine keeps the version itself by remembering what it last read. It
              only sees changes between its own reads, so it is not the same guarantee as
              a merchant-supplied version.
            </p>
          </div>

          <div className="panel">
            <h2>Nordwell&rsquo;s catalogue, translated</h2>
            <p className="lead">
              Prices arrive as decimal strings under <code>pricing.unit.amount</code>,
              stock as <code>availability.quantity</code>, vegan status as a tag list.
              This is what the invariants see after mapping.
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
                  <th>Category</th>
                </tr>
              </thead>
              <tbody>
                {result.catalogue?.map((product) => (
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
                    <td>{product.category}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <h2>A clean journey</h2>
            <ul className="trace">
              {result.clean?.steps.map((step, index) => (
                <li key={index} data-tone={step.tone}>
                  <span className="mono">{step.label}</span> — {step.detail}
                </li>
              ))}
            </ul>
            <div className="meta">
              <div>
                <span>Total</span>₹{result.clean?.total}
              </div>
              <div>
                <span>Violations</span>
                {result.clean?.violations}
              </div>
              <div>
                <span>Rules withheld</span>
                {result.clean?.withheld.length
                  ? result.clean.withheld.join(", ")
                  : "none"}
              </div>
            </div>
            <p className="meta">
              {result.clean?.withheld.includes("INV-INVENTORY")
                ? "INV-INVENTORY was withheld by name because Nordwell cannot hold stock — it has no reservation concept. A withheld rule is reported as not run, never counted as a pass it did not earn."
                : "No rule was withheld."}
            </p>
          </div>

          <div className="panel">
            <h2>The same journey, with Nordwell re-pricing mid-flight</h2>
            <p className="lead">
              Quoted at ₹{result.reprice?.quotedAt}, approved, and then Nordwell raises
              the price to ₹{result.reprice?.newPrice} before checkout. Nordwell has no
              price version field at all, so the only way to notice is that the engine
              remembers what it last read.
            </p>
            <div className="meta">
              <div>
                <span>Checkout</span>
                {result.reprice?.blocked ? "blocked" : "ALLOWED — this is a bug"}
              </div>
              <div>
                <span>Fired</span>
                {result.reprice?.fired.length
                  ? result.reprice.fired.join(", ")
                  : "nothing"}
              </div>
            </div>
            {result.reprice?.reason && (
              <pre className="mono">{result.reprice.reason}</pre>
            )}
          </div>
        </>
      )}

      <div className="panel">
        <h2>Let a model write the mapping</h2>
        <p className="lead">
          The mapping above was written by hand — someone read Nordwell&rsquo;s response
          and worked out which field was the price. A model does that in seconds. It is
          also capable of being confidently wrong about it, and that field is the amount a
          buyer is charged. So the model <strong>proposes</strong>, and deterministic code
          decides: a proposal is accepted only by being used to build a real product from
          real rows, through the same strict readers the hand-written path uses.
        </p>
        <button className="primary" onClick={infer} disabled={inferring}>
          {inferring ? "Asking the model…" : "Infer the mapping with a model"}
        </button>
        {inferring && (
          <p className="meta">
            One model call, then two full journeys — the inferred mapping and the
            hand-written one, so the verdicts can be compared.
          </p>
        )}
      </div>

      {inferred && !inferred.ok && inferred.reason === "no-model" && (
        <div className="panel">
          <h2>No model configured</h2>
          <p className="lead">
            Refusing rather than substituting a scripted stub — inferring a mapping from a
            canned reply would demonstrate nothing while looking like it had.
          </p>
          <pre className="mono">{inferred.error}</pre>
        </div>
      )}

      {inferred && !inferred.ok && inferred.reason === "rejected" && (
        <div className="panel">
          <h2>Proposal rejected — nothing was run against it</h2>
          <p className="lead">
            This is the mechanism working, and it is the more reassuring of the two
            outcomes to watch. The model asserted something the response does not support,
            and validation refused it. The alternative is a mapping that reads the wrong
            field and reports confident verdicts about the wrong amount of money.
          </p>
          <ul className="trace">
            {inferred.problems?.map((problem, index) => (
              <li key={index} data-tone="blocked">
                {problem}
              </li>
            ))}
          </ul>
        </div>
      )}

      {inferred && !inferred.ok && inferred.reason === "error" && (
        <div className="panel">
          <h2>Could not complete the inference</h2>
          <pre className="mono">{inferred.error}</pre>
        </div>
      )}

      {inferred?.ok && (
        <>
          <div className="panel">
            <h2>What the model proposed</h2>
            <p className="lead">
              Written by <span className="mono">{inferred.model}</span> from one response,
              and accepted only after a real product was built with these paths.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Path the model chose</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(inferred.mapping ?? {}).map(([field, path]) => (
                  <tr key={field}>
                    <td>{field}</td>
                    <td className="mono">{path ?? "not mapped"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="meta">
              <div>
                <span>Capabilities</span>
                {inferred.capabilities?.length} of 8
              </div>
              <div>
                <span>Engine-tracked</span>
                {inferred.derivedCapabilities?.join(", ") || "none"}
              </div>
            </div>
            {/*
              The one thing validation cannot settle, so it is put in front of a person
              rather than assumed. Nothing in "649.00" says whether the merchant means
              ₹649.00 or ₹6.49, and both readings are self-consistent.
            */}
            <p className="lead" style={{ marginBottom: 0 }}>
              Inferred price: <strong>{inferred.priceForReview}</strong> — a human
              confirms this. Nothing in the data distinguishes ₹649.00 from ₹6.49, so the
              unit is the one judgement left to you.
            </p>
            {inferred.notes && (
              <p className="meta">Model&rsquo;s notes: {inferred.notes}</p>
            )}
          </div>

          <div className="panel">
            <h2>Same journey, both mappings</h2>
            <table>
              <thead>
                <tr>
                  <th>Mapping</th>
                  <th>Total</th>
                  <th>Checkout</th>
                  <th>Fired</th>
                  <th>Withheld</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ["hand-written", inferred.handWritten],
                    ["model-written", inferred.modelWritten],
                  ] as const
                ).map(([label, verdict]) => (
                  <tr key={label}>
                    <td>{label}</td>
                    <td>₹{verdict?.total}</td>
                    <td>{verdict?.blocked ? "blocked" : "allowed"}</td>
                    <td className="mono">{verdict?.fired.join(", ") || "—"}</td>
                    <td className="mono">{verdict?.withheld.join(", ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="lead" style={{ marginBottom: 0 }}>
              {inferred.agree
                ? "Identical verdicts. A mapping a model wrote from one response reached the same conclusions as the one written by hand — including catching the price move against a merchant that publishes no version field."
                : "The two mappings disagree. Shown rather than reconciled: a difference here means the model read a different field, and which one is right is not something this page should decide."}
            </p>
          </div>
        </>
      )}
    </>
  );
}
