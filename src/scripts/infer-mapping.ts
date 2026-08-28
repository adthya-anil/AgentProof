import { llmFromEnv } from "../lib/agent/factory.js";
import { loadDotEnv } from "../lib/core/env.js";
import { createEnvironment, createIntent } from "../lib/harness.js";
import type { ToolResult } from "../lib/guard/guard.js";
import { MerchantAdapter } from "../lib/merchant/adapter.js";
import { inferMapping } from "../lib/merchant/infer.js";
import { parseMerchantSchema, type MerchantSchema } from "../lib/merchant/mapping.js";
import { AdapterCatalogSource } from "../lib/merchant/source.js";
import { transportFor } from "../lib/merchant/transport.js";
import { NORDWELL_MAPPING } from "../lib/merchants/nordwell.js";

/**
 * Writes the mapping with a model, then refuses to trust it without proof.
 *
 * The mapping is the last hand-authored thing in the adapter, and a model reads an
 * unfamiliar API response far faster than a person. What a model must not do is decide
 * which field is the price — so it proposes, and deterministic validation decides.
 *
 * The interesting result is not that the model produces *a* mapping. It is whether the
 * mapping it produces reaches the same verdicts as the hand-written one, on the same
 * journey. If it does, the authoring step is automatable. If it does not, this prints the
 * difference rather than averaging over it.
 *
 *   npm run build && npm start
 *   npm run demo:infer
 */

const BASE = process.env.AGENTPROOF_BASE_URL ?? "http://127.0.0.1:3000";
const ENDPOINT = `${BASE}/api/merchant/nordwell`;
const IDS = ["NW-1001", "NW-1005"];

/**
 * Both mappings aimed at the server actually under test.
 *
 * NORDWELL_MAPPING carries a default endpoint on port 3000, so comparing against it
 * verbatim sent the hand-written half to a port with nothing on it — "fetch failed",
 * after the interesting work had already succeeded.
 */
function atThisServer(schema: MerchantSchema): MerchantSchema {
  return { ...schema, transport: { ...schema.transport, endpoint: ENDPOINT } as never };
}

const QUERY = `query Catalogue($ids: [ID!]!) {
  products(ids: $ids) {
    id
    title
    collection
    pricing { unit { amount currencyCode } floor { amount } }
    availability { quantity }
    dietary { contains tags }
    giftable
  }
}`;

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(26)}${value}`);
}

function ok<T>(label: string, result: ToolResult): T {
  if (!result.ok) throw new Error(`${label}: ${result.reason}`);
  return result.data as T;
}

/** Runs one journey and returns what the Guard concluded. */
async function judge(
  schema: MerchantSchema,
): Promise<{ total: number; blocked: boolean; fired: string[]; withheld: string[] }> {
  const env = createEnvironment({});
  const adapter = new MerchantAdapter(schema, transportFor(schema));
  const source = new AdapterCatalogSource(adapter, env.state);
  await source.prime(IDS);
  env.guard.setCatalogSource(source);
  env.guard.beginIntent(
    createIntent(env.ids, env.clock, {
      runId: "infer",
      utterance: "a coffee gift set",
      maxBudget: 3000,
    }),
  );

  const bundle = await env.guard.callTool("create_bundle", {
    items: IDS.map((id) => ({ product_id: id, quantity: 1 })),
  });
  const quote = await env.guard.callTool("create_quote", {
    bundle_id: ok<{ bundle_id: string }>("create_bundle", bundle).bundle_id,
  });
  const priced = ok<{ quote_id: string; total: number }>("create_quote", quote);
  const approval = await env.guard.callTool("approve_quote", {
    quote_id: priced.quote_id,
    approved_amount: priced.total,
    confirmation_text: "yes",
  });
  const receipt = ok<{ approval_receipt_id: string }>("approve_quote", approval);

  // Move the price under the journey, so the run has something to catch.
  await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query:
        "mutation($id: ID!, $amount: String!) { setPrice(id: $id, amount: $amount) { id } }",
      variables: { id: "NW-1001", amount: "699.00" },
    }),
  });

  const checkout = await env.guard.callTool("create_checkout", {
    quote_id: priced.quote_id,
    approval_receipt_id: receipt.approval_receipt_id,
  });

  await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "mutation { resetCatalogue }" }),
  });

  return {
    total: priced.total,
    blocked: !checkout.ok,
    fired: [
      ...new Set(
        env.guard
          .recordedViolations()
          .concat(env.guard.recordedEscalations())
          .map((v) => v.invariantId),
      ),
    ].sort(),
    withheld: [
      ...new Set(
        env.guard
          .allEvaluations()
          .flatMap((e) => e.capabilityGaps.map((g) => g.invariantId)),
      ),
    ].sort(),
  };
}

async function main(): Promise<void> {
  loadDotEnv();

  const llm = llmFromEnv();
  if (!llm.isReal) {
    console.error(
      "\n  This needs a real model — inferring a mapping is the whole point.\n" +
        "  Set LLM_API_KEY, LLM_MODEL and LLM_BASE_URL.\n",
    );
    process.exitCode = 1;
    return;
  }

  console.log("\nInferring a merchant mapping, then proving it before trusting it\n");
  line("Model", llm.name);
  line("Merchant", `${ENDPOINT} (shape unknown to the model)`);

  // One real response, exactly what a new integrator would have to hand.
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { ids: IDS } }),
  });
  const sample = await response.json();

  const inferred = await inferMapping({
    llm,
    merchant: "nordwell-inferred",
    label: "Nordwell (mapping written by a model)",
    transport: atThisServer(parseMerchantSchema(NORDWELL_MAPPING)).transport,
    sample,
    requestedIds: IDS,
  });

  if (!inferred.ok) {
    console.log("\n  Proposal REJECTED. Nothing was run against it.\n");
    for (const problem of inferred.problems) console.log(`    ✗ ${problem}`);
    console.log(
      "\n  A rejected proposal is the system working. The alternative is a mapping\n" +
        "  that reads the wrong field and reports confident verdicts about the wrong\n" +
        "  amount of money.\n",
    );
    process.exitCode = 1;
    return;
  }

  console.log("\n  The model proposed, and the proposal survived validation:\n");
  line("Price path", inferred.schema.product.price.path);
  line("Unit", inferred.schema.product.price.unit);
  line("Name path", inferred.schema.product.name);
  line("Stock path", inferred.schema.inventory.available ?? "not mapped");
  line("Vegan path", inferred.schema.product.vegan?.path ?? "not mapped");
  line("Allergens path", inferred.schema.product.allergens?.path ?? "not mapped");
  line("Capabilities", `${inferred.capabilities.length} of 8`);
  console.log();
  line("Price for review", `${inferred.priceForReview}  ← a human confirms this`);
  if (inferred.notes) console.log(`\n  Model's notes: ${inferred.notes}\n`);

  // -- the comparison that matters ----------------------------------------
  const handWritten = await judge(atThisServer(parseMerchantSchema(NORDWELL_MAPPING)));
  const modelWritten = await judge(atThisServer(inferred.schema));

  console.log("  Same journey, both mappings:\n");
  console.log("    mapping        total   checkout   fired                withheld");
  for (const [name, r] of [
    ["hand-written", handWritten],
    ["model-written", modelWritten],
  ] as const) {
    console.log(
      `    ${name.padEnd(15)}₹${String(r.total).padEnd(7)}${(r.blocked ? "blocked" : "ALLOWED").padEnd(11)}` +
        `${(r.fired.join(",") || "-").padEnd(21)}${r.withheld.join(",") || "-"}`,
    );
  }

  const same =
    handWritten.total === modelWritten.total &&
    handWritten.blocked === modelWritten.blocked &&
    handWritten.fired.join() === modelWritten.fired.join() &&
    handWritten.withheld.join() === modelWritten.withheld.join();

  console.log();
  if (same) {
    console.log(
      "✓ Identical verdicts. The mapping a model wrote from one response reached the\n" +
        "  same conclusions as the one written by hand — including catching the price\n" +
        "  move against a merchant that publishes no price version.\n" +
        "  The unit remains a human's call: nothing in the data distinguishes ₹649.00\n" +
        "  from ₹6.49, so the amount above is shown for confirmation, not assumed.\n",
    );
  } else {
    console.error(
      "✗ The two mappings disagree. Printed rather than reconciled — a difference here\n" +
        "  means the model read a different field, and which one is right is not\n" +
        "  something this script should decide.\n",
    );
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
