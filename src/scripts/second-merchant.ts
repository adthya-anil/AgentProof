import { createEnvironment, createIntent } from "../lib/harness.js";
import { MerchantAdapter } from "../lib/merchant/adapter.js";
import { parseMerchantSchema } from "../lib/merchant/mapping.js";
import { AdapterCatalogSource } from "../lib/merchant/source.js";
import { transportFor } from "../lib/merchant/transport.js";
import { NORDWELL_MAPPING } from "../lib/merchants/nordwell.js";
import { formatMinor } from "../lib/core/money.js";
import type { ToolResult } from "../lib/guard/guard.js";

/**
 * The adapter, proved against a second merchant.
 *
 * Everything before this demonstrated portability with a test double. A double proves the
 * mapping code reads fields; it cannot prove the engine copes with a merchant designed
 * without it in mind, because the double and the engine share an author and a set of
 * assumptions. Nordwell is a separate GraphQL service with its own data model, reached
 * over HTTP.
 *
 * Requires the app to be running, because the point is that the traffic is real:
 *
 *   npm run build && npm start
 *   npm run demo:merchant
 */

const BASE = process.env.AGENTPROOF_BASE_URL ?? "http://127.0.0.1:3000";
const ENDPOINT = `${BASE}/api/merchant/nordwell`;

/**
 * Asks Nordwell to change something, through Nordwell.
 *
 * The catalogue lives in the server process, not this one. Calling a local setter would
 * re-price this script's own memory and leave the merchant answering the old price —
 * which the first version of this demo did, then reported a missed detection that had
 * never happened.
 */
async function mutate(query: string, variables: Record<string, unknown>): Promise<void> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json()) as { errors?: Array<{ message?: string }> };
  if (body.errors?.length) {
    throw new Error(`nordwell rejected the mutation: ${body.errors[0]?.message}`);
  }
}

function ok<T>(label: string, result: ToolResult): T {
  if (!result.ok) throw new Error(`${label} failed: ${result.reason}`);
  return result.data as T;
}

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(28)}${value}`);
}

async function main(): Promise<void> {

  const schema = parseMerchantSchema({
    ...NORDWELL_MAPPING,
    transport: {
      ...NORDWELL_MAPPING.transport,
      endpoint: ENDPOINT,
    },
  });

  const env = createEnvironment({});
  const adapter = new MerchantAdapter(schema, transportFor(schema));
  const source = new AdapterCatalogSource(adapter, env.state);

  console.log("\nSecond merchant: the adapter against a catalogue it has never seen\n");
  line("Merchant", schema.label);
  line("Transport", `${schema.transport.kind} — ${ENDPOINT}`);

  const ids = ["NW-1001", "NW-1005", "NW-1006"];

  // Load Nordwell's catalogue as the starting state, so pricing and verification
  // descend from the same read rather than from HamperHub's seed data.
  try {
    await mutate("mutation { resetCatalogue }", {});
    await source.prime(ids);
  } catch (error) {
    console.error(
      `\n  Could not reach ${BASE}/api/merchant/nordwell — is the app running?` +
        `\n  ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const capabilities = source.capabilities();
  const derived = source.derivedCapabilities();
  line("Capabilities", `${capabilities.size} of 8 — ${capabilities.declared.join(", ")}`);
  line("Engine-tracked", derived.length ? derived.join(", ") : "none");
  line(
    "Not available",
    ["reservation.lookup"].filter((c) => !capabilities.declared.includes(c as never))
      .join(", ") || "none",
  );

  console.log("\n  Catalogue as the engine now sees it, translated from GraphQL:");
  for (const id of ids) {
    const product = env.state.getProduct(id);
    if (!product) continue;
    const stock = env.state.freeStock(id);
    const allergens =
      product.allergens === null
        ? "unknown"
        : product.allergens.length === 0
          ? "none declared"
          : product.allergens.join("/");
    line(
      `  ${id}`,
      `${formatMinor(product.priceMinor)}  stock ${stock}  ` +
        `vegan ${String(product.vegan)}  allergens ${allergens}  ${product.category}`,
    );
  }

  // -- a clean journey ------------------------------------------------------
  const guard = env.guard;
  guard.setCatalogSource(source);
  guard.beginIntent(
    createIntent(env.ids, env.clock, {
      runId: "nordwell-clean",
      utterance: "a coffee gift set under ₹1,500",
      maxBudget: 1500,
    }),
  );

  console.log("\n  A clean journey:");
  const bundle = await guard.callTool("create_bundle", {
    items: [
      { product_id: "NW-1001", quantity: 1 },
      // NW-1005, not the gift box: Nordwell marks NW-1006 `giftable: false`, and the
      // merchant refusing to bundle it is correct behaviour rather than a fault to
      // work around.
      { product_id: "NW-1005", quantity: 1 },
    ],
  });
  const bundleId = ok<{ bundle_id: string }>("create_bundle", bundle).bundle_id;

  const quote = await guard.callTool("create_quote", { bundle_id: bundleId });
  const priced = ok<{ quote_id: string; total: number }>("create_quote", quote);
  line("  quote", `${priced.quote_id} at ₹${priced.total}`);

  const approval = await guard.callTool("approve_quote", {
    quote_id: priced.quote_id,
    approved_amount: priced.total,
    confirmation_text: "yes, buy it",
  });
  const receipt = ok<{ approval_receipt_id: string }>("approve_quote", approval);

  const checkout = await guard.callTool("create_checkout", {
    quote_id: priced.quote_id,
    approval_receipt_id: receipt.approval_receipt_id,
  });
  line("  checkout", checkout.ok ? "allowed" : `blocked — ${checkout.reason}`);
  line("  violations", String(guard.recordedViolations().length));

  const withheld = new Set(
    guard.allEvaluations().flatMap((e) => e.capabilityGaps.map((g) => g.invariantId)),
  );
  line(
    "  rules withheld",
    withheld.size ? [...withheld].join(", ") : "none",
  );

  // -- the same merchant, re-pricing mid-journey ----------------------------
  console.log(
    "\n  The same journey, with Nordwell re-pricing between approval and checkout:",
  );

  const env2 = createEnvironment({});
  const source2 = new AdapterCatalogSource(adapter, env2.state);
  await source2.prime(ids);
  const guard2 = env2.guard;
  guard2.setCatalogSource(source2);
  guard2.beginIntent(
    createIntent(env2.ids, env2.clock, {
      runId: "nordwell-reprice",
      utterance: "a coffee gift set",
      maxBudget: 1500,
    }),
  );

  const b2 = await guard2.callTool("create_bundle", {
    items: [{ product_id: "NW-1001", quantity: 1 }],
  });
  const q2 = await guard2.callTool("create_quote", {
    bundle_id: ok<{ bundle_id: string }>("create_bundle", b2).bundle_id,
  });
  const priced2 = ok<{ quote_id: string; total: number }>("create_quote", q2);
  line("  quoted at", `₹${priced2.total}`);

  const a2 = await guard2.callTool("approve_quote", {
    quote_id: priced2.quote_id,
    approved_amount: priced2.total,
    confirmation_text: "go ahead",
  });
  const r2 = ok<{ approval_receipt_id: string }>("approve_quote", a2);

  // Nordwell raises the price, through Nordwell. It has no version field, so the only
  // way to notice is that the engine remembers what it last read.
  await mutate(
    "mutation($id: ID!, $amount: String!) { setPrice(id: $id, amount: $amount) { id } }",
    { id: "NW-1001", amount: "699.00" },
  );
  line("  merchant re-priced to", "₹699.00");

  const c2 = await guard2.callTool("create_checkout", {
    quote_id: priced2.quote_id,
    approval_receipt_id: r2.approval_receipt_id,
  });
  line("  checkout", c2.ok ? "ALLOWED — this is a bug" : "blocked");
  const fired = guard2
    .recordedViolations()
    .concat(guard2.recordedEscalations())
    .map((v) => v.invariantId);
  line("  fired", fired.length ? [...new Set(fired)].join(", ") : "nothing");

  await mutate("mutation { resetCatalogue }", {});

  const priceBindingHeld = fired.includes("INV-PRICE-BINDING");
  const inventoryWithheld = withheld.has("INV-INVENTORY");

  console.log("");
  if (priceBindingHeld && inventoryWithheld && guard.recordedViolations().length === 0) {
    console.log(
      "✓ Same twelve rules, a merchant they were not written for. Price binding held\n" +
        "  without any merchant version field; the inventory rule was withheld by name\n" +
        "  rather than run against reservations Nordwell does not have.\n",
    );
  } else {
    console.error(
      "✗ Expected a clean first journey, INV-PRICE-BINDING on the re-price, and\n" +
        "  INV-INVENTORY withheld. Got: " +
        `violations=${guard.recordedViolations().length}, fired=[${fired.join(", ")}], ` +
        `withheld=[${[...withheld].join(", ")}]\n`,
    );
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
