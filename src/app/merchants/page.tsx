import { Tabs } from "@/app/components";
import type { IntegrationVariant } from "@/lib/dashboard/data";
import { MerchantConsole } from "./MerchantConsole";

/**
 * Two merchants, one policy.
 *
 * The hardest claim in this product to believe is that the twelve invariants are not
 * built around HamperHub, and it was the only claim with no page — it lived in a
 * terminal command, so anyone shown the dashboard saw twelve rules against one merchant
 * and had to take the rest on trust.
 */
export const dynamic = "force-dynamic";

export default async function MerchantsPage({
  searchParams,
}: {
  searchParams: Promise<{ integration?: string }>;
}) {
  const params = await searchParams;
  const variant: IntegrationVariant =
    params.integration === "vulnerable" ? "vulnerable" : "fixed";

  return (
    <>
      <Tabs active="merchants" variant={variant} />

      <div className="panel">
        <h2>Two merchants, one policy</h2>
        <p className="lead">
          HamperHub is built to the entity model the invariants were written against:
          products carry a price version, inventory records carry a version, allergens
          are structured. Almost no real catalogue does. Nordwell is the counter-example
          — and the rules run against it unchanged.
        </p>
        <table>
          <thead>
            <tr>
              <th />
              <th>HamperHub</th>
              <th>Nordwell Provisions</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Transport</td>
              <td>in-process</td>
              <td className="mono">GraphQL over HTTP</td>
            </tr>
            <tr>
              <td>Product id</td>
              <td className="mono">p-coffee-arabica</td>
              <td className="mono">NW-1001</td>
            </tr>
            <tr>
              <td>Price</td>
              <td className="mono">priceMinor: 59900</td>
              <td className="mono">pricing.unit.amount: &quot;649.00&quot;</td>
            </tr>
            <tr>
              <td>Stock</td>
              <td className="mono">available: 8</td>
              <td className="mono">availability.quantity: 12</td>
            </tr>
            <tr>
              <td>Vegan</td>
              <td className="mono">vegan: true</td>
              <td className="mono">dietary.tags: [&quot;PLANT_BASED&quot;]</td>
            </tr>
            <tr>
              <td>Allergens</td>
              <td className="mono">allergens: []</td>
              <td className="mono">dietary.contains, or absent</td>
            </tr>
            <tr>
              <td>Price version</td>
              <td>monotonic counter</td>
              <td>
                <strong>none</strong>
              </td>
            </tr>
            <tr>
              <td>Reservations</td>
              <td>yes</td>
              <td>
                <strong>none</strong>
              </td>
            </tr>
          </tbody>
        </table>
        <p className="meta">
          The last two rows decide what can be checked. Nordwell cannot hold stock, so
          the inventory rule is withheld by name rather than run against a reservation it
          has never heard of. It has no price version either, and price binding still
          works — the engine keeps that counter itself.
        </p>
      </div>

      <MerchantConsole />

      <div className="panel">
        <h2>What this does not show</h2>
        <p className="lead">
          Both merchants are ours. Neither has the pagination, rate limits, partial
          failures or eventual consistency of a real storefront, and there is still one
          policy file. What running against Nordwell did prove is narrower and real: it
          found two bugs no unit test had, because the fixtures had been written from the
          same assumptions as the code — a tag list read as not-vegan, which would have
          made the safety rule reject a correct integration, and a re-price that never
          happened because the demo was mutating its own memory rather than the
          merchant&rsquo;s.
        </p>
      </div>
    </>
  );
}
