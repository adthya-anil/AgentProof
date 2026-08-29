import { Tabs } from "@/app/components";
import type { IntegrationVariant } from "@/lib/dashboard/data";
import { SEED_CATALOG, SEED_INVENTORY } from "@/lib/hamperhub/catalog";
import { parseMerchantSchema, readPath } from "@/lib/merchant/mapping";
import { NORDWELL_CATALOG, NORDWELL_MAPPING } from "@/lib/merchants/nordwell";
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

  /**
   * The comparison, read out of the two merchants rather than typed by hand.
   *
   * It was typed by hand first, and that was wrong for a reason worth keeping: six
   * values sitting in JSX above a Run button, describing facts the code already knew.
   * A reader could not tell the prose from the results — and if a mapping path or a seed
   * price ever changed, the table would have gone on stating the old one with nothing to
   * catch it. Derived, it cannot drift, and "is this hardcoded?" has a real answer.
   */
  const hamperhub = SEED_CATALOG[0]!;
  const nordwell = NORDWELL_CATALOG[0]!;
  /**
   * Parsed rather than read as a literal.
   *
   * Two reasons. The literal's `as const` type has no `priceVersion` key at all —
   * TypeScript rejected reading it, which is the type system making the page's own point
   * — and parsing means a mapping this page cannot validate fails here rather than
   * rendering a confident table describing a broken configuration.
   */
  const mapping = parseMerchantSchema(NORDWELL_MAPPING);

  const priceVersionSource = mapping.product.priceVersion
    ? mapping.product.priceVersion
    : mapping.derive.priceVersion
      ? "none — engine tracks it"
      : "none";

  const comparison: Array<{ label: string; hamperhub: string; nordwell: string }> = [
    {
      label: "Transport",
      hamperhub: "in-process",
      nordwell: `${mapping.transport.kind} over HTTP`,
    },
    { label: "Product id", hamperhub: hamperhub.id, nordwell: nordwell.id },
    {
      label: "Price",
      hamperhub: `priceMinor: ${hamperhub.priceMinor}`,
      nordwell: `${mapping.product.price.path}: ${JSON.stringify(
        readPath(nordwell, mapping.product.price.path),
      )}`,
    },
    {
      label: "Stock",
      hamperhub: `available: ${SEED_INVENTORY[hamperhub.id] ?? 0}`,
      nordwell: mapping.inventory.available
        ? `${mapping.inventory.available}: ${String(
            readPath(nordwell, mapping.inventory.available),
          )}`
        : "not exposed",
    },
    {
      label: "Vegan",
      hamperhub: `vegan: ${String(hamperhub.vegan)}`,
      nordwell: mapping.product.vegan
        ? `${mapping.product.vegan.path}: ${JSON.stringify(
            readPath(nordwell, mapping.product.vegan.path),
          )}`
        : "not exposed",
    },
    {
      label: "Allergens",
      hamperhub: `allergens: ${JSON.stringify(hamperhub.allergens)}`,
      nordwell: mapping.product.allergens
        ? `${mapping.product.allergens.path}, or absent`
        : "not exposed",
    },
    {
      label: "Price version",
      hamperhub: `priceVersion: ${hamperhub.priceVersion} (monotonic)`,
      nordwell: priceVersionSource,
    },
    {
      label: "Reservations",
      hamperhub: "yes",
      nordwell: mapping.supportsReservations ? "yes" : "none",
    },
  ];

  return (
    <>
      <Tabs active="merchants" variant={variant} />

      <div className="panel">
        <h2>Two merchants, one policy</h2>
        <p className="lead">
          HamperHub is built to the entity model the invariants were written against:
          products carry a price version, inventory records carry a version, allergens are
          structured. Almost no real catalogue does. Nordwell is the counter-example — a
          separate GraphQL service with its own data model, and the rules run against it
          unchanged.
        </p>
        <p className="meta">
          Reached over real HTTP: a TCP connection, a POST, a GraphQL query, and GraphQL
          error semantics — stop the server and the catalogue becomes unreadable, because
          there is no in-process shortcut. It is <em>not</em> a third party&rsquo;s
          infrastructure, though: same codebase, on localhost, with no auth, rate limits,
          pagination or latency. It exercises the transport, not the realities of
          integrating with someone else&rsquo;s systems.
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
            {comparison.map((row) => (
              <tr key={row.label}>
                <td>{row.label}</td>
                <td className="mono">{row.hamperhub}</td>
                <td className="mono">{row.nordwell}</td>
              </tr>
            ))}
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
          policy file. The twelve deterministic regression scenarios also stay on
          HamperHub — they name exact products on purpose, and generalising them to
          &ldquo;something cheap&rdquo; would destroy the precision that makes them a
          regression floor. What ports is the agent-driven half, which never named a
          product.
        </p>
        <p className="meta">
          What running against Nordwell did prove is narrower and real: it found two bugs
          no unit test had, because the fixtures had been written from the same assumptions
          as the code — a tag list read as not-vegan, which would have made the safety rule
          reject a correct integration, and a re-price that never happened because the demo
          was mutating its own memory rather than the merchant&rsquo;s.
        </p>
      </div>
    </>
  );
}
