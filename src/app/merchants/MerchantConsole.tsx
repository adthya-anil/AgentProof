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

export function MerchantConsole() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

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
    </>
  );
}
