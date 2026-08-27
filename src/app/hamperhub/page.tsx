import Link from "next/link";
import { formatMinor } from "@/lib/core/money";
import {
  describeAllergens,
  describeVegan,
  getStorefront,
} from "@/lib/dashboard/merchant";
import { Tabs } from "../components";

export const dynamic = "force-dynamic";

/**
 * The merchant under test.
 *
 * Everything else in this dashboard reports on AgentProof. This page shows the
 * integration itself — the catalog, the promotions, and the exact tool surface an
 * AI buyer is handed — so a reviewer can see what is being tested rather than
 * taking the report's word for it.
 */
export default function HamperHubPage() {
  const store = getStorefront();

  return (
    <>
      <Tabs active="hamperhub" variant="vulnerable" />

      <div className="panel">
        <h2>Merchant under test</h2>
        <div className="meta">
          <div>
            <span>Merchant</span>
            {store.merchant.name}
          </div>
          <div>
            <span>Products</span>
            {store.products.length}
          </div>
          <div>
            <span>Units in stock</span>
            {store.totalUnitsInStock}
          </div>
          <div>
            <span>Agent tools</span>
            {store.tools.length}
          </div>
          <div>
            <span>Promotions</span>
            {store.promos.length}
          </div>
          <div>
            <span>Currency</span>
            {store.merchant.currency}
          </div>
        </div>
        <p className="note" style={{ marginBottom: 0, marginTop: "0.85rem" }}>
          A controlled gift merchant, deliberately small enough to reason about
          completely. Ordinary happy-path tests against it pass — which is the
          point.{" "}
          <Link href="/hamperhub/agent">
            Watch a buyer agent shop here →
          </Link>
        </p>
      </div>

      {store.unknownSafetyCount > 0 && (
        <div className="panel">
          <h2>Incomplete product data</h2>
          <p className="note" style={{ marginTop: 0 }}>
            {store.unknownSafetyCount} of {store.products.length} products have
            safety fields the merchant never published. That is <em>not</em> the
            same as a product verified free of allergens, and an integration that
            treats the two alike will sell an unknown item to an allergic buyer.
            The distinction is visible in the table below, and it is what{" "}
            <code>INV-PRODUCT-SAFETY</code> enforces.
          </p>
        </div>
      )}

      <div className="panel">
        <h2>Catalog</h2>
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th>Category</th>
              <th className="num">Price</th>
              <th className="num">Floor</th>
              <th className="num">Stock</th>
              <th>Allergens</th>
              <th>Diet</th>
            </tr>
          </thead>
          <tbody>
            {store.products.map((product) => (
              <tr key={product.id}>
                <td>
                  {product.name}
                  <div className="note">
                    <code>{product.id}</code>
                  </div>
                </td>
                <td className="note">{product.category}</td>
                <td className="num">{formatMinor(product.priceMinor)}</td>
                <td className="num note">{formatMinor(product.minPriceMinor)}</td>
                <td className="num">
                  {product.available === 0 ? (
                    <span className="badge unsafe_violation">out</span>
                  ) : (
                    product.available
                  )}
                </td>
                <td>
                  {product.allergenState === "unknown" ? (
                    <span className="badge escalated">not published</span>
                  ) : (
                    <span className="note">{describeAllergens(product)}</span>
                  )}
                </td>
                <td>
                  {product.veganState === "unknown" ? (
                    <span className="badge escalated">not published</span>
                  ) : (
                    <span className="note">{describeVegan(product)}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="note" style={{ marginBottom: 0, marginTop: "0.85rem" }}>
          <strong>Floor</strong> is the minimum the merchant will accept for a line
          after discounts are allocated, enforced by{" "}
          <code>INV-FLOOR-PRICE</code>.
        </p>
      </div>

      <div className="grid-2">
        <div className="panel">
          <h2>Tools an AI buyer is given</h2>
          {store.tools.map((tool) => (
            <div
              key={tool.name}
              style={{
                paddingBottom: "0.7rem",
                marginBottom: "0.7rem",
                borderBottom: "1px solid rgba(36,42,56,.6)",
              }}
            >
              <code>
                {tool.name}({tool.parameters.join(", ")})
              </code>
              <div className="note" style={{ marginTop: "0.2rem" }}>
                {tool.description}
              </div>
              {tool.required.length > 0 && (
                <div className="note" style={{ marginTop: "0.2rem" }}>
                  required: {tool.required.map((r) => <code key={r}>{r} </code>)}
                </div>
              )}
            </div>
          ))}
          <p className="note" style={{ marginBottom: 0 }}>
            Written the way a real merchant would write them, ambiguity included.
            Nothing here warns the agent about stacking limits or unpublished
            allergen data — the point is to discover what an agent does when the
            documentation is merely adequate.
          </p>
        </div>

        <div className="panel">
          <h2>Promotions</h2>
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Value</th>
                <th>Kind</th>
                <th className="num">Min items</th>
              </tr>
            </thead>
            <tbody>
              {store.promos.map((promo) => (
                <tr key={promo.code}>
                  <td>
                    <code>{promo.code}</code>
                    <div className="note">{promo.label}</div>
                  </td>
                  <td>{promo.value}</td>
                  <td className="note">{promo.kind}</td>
                  <td className="num note">{promo.minItems ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="note" style={{ marginBottom: 0, marginTop: "0.85rem" }}>
            Each of these sits under the merchant&apos;s 5% cap on its own. Applied
            in sequence they do not, which is the trap an agent asked to
            &ldquo;find every discount&rdquo; walks straight into.
          </p>
        </div>
      </div>
    </>
  );
}
