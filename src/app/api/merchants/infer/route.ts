import { type NextRequest, NextResponse } from "next/server";
import { llmFromEnv } from "@/lib/agent/factory";
import { loadDotEnv } from "@/lib/core/env";
import type { ToolResult } from "@/lib/guard/guard";
import { createEnvironment, createIntent } from "@/lib/harness";
import { MerchantAdapter } from "@/lib/merchant/adapter";
import { inferMapping } from "@/lib/merchant/infer";
import { type MerchantSchema, parseMerchantSchema } from "@/lib/merchant/mapping";
import { AdapterCatalogSource } from "@/lib/merchant/source";
import { transportFor } from "@/lib/merchant/transport";
import { NORDWELL_MAPPING } from "@/lib/merchants/nordwell";

/**
 * Asks a model to write the mapping, then proves it before showing a verdict.
 *
 * The browser version of `npm run demo:infer`. Worth having in the dashboard rather than
 * only a terminal, because the claim is easy to state and hard to believe — "a model read
 * an API it had never seen and produced a mapping that reaches the same verdicts as the
 * hand-written one" is exactly the sort of sentence that deserves to be run in front of
 * whoever is doubting it.
 *
 * Both outcomes are worth rendering. A rejected proposal is not an error page: it is the
 * mechanism working, and it is the more reassuring of the two results to watch.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const IDS = ["NW-1001", "NW-1005"];

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

function ok<T>(result: ToolResult): T {
  if (!result.ok) throw new Error(result.reason);
  return result.data as T;
}

function endpointFor(request: NextRequest): string {
  const origin =
    request.headers.get("origin") ??
    `${request.nextUrl.protocol}//${request.headers.get("host") ?? request.nextUrl.host}`;
  return `${origin}/api/merchant/nordwell`;
}

/** Points a mapping at the server actually running, not the port baked into it. */
function atThisServer(schema: MerchantSchema, endpoint: string): MerchantSchema {
  return { ...schema, transport: { ...schema.transport, endpoint } as never };
}

async function graphql(
  endpoint: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json()) as { errors?: Array<{ message?: string }> };
  if (body.errors?.length) {
    throw new Error(body.errors[0]?.message ?? "nordwell rejected the request");
  }
  return body;
}

/** One journey, reporting only what the Guard concluded. */
async function judge(
  schema: MerchantSchema,
  endpoint: string,
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
    bundle_id: ok<{ bundle_id: string }>(bundle).bundle_id,
  });
  const priced = ok<{ quote_id: string; total: number }>(quote);
  const approval = await env.guard.callTool("approve_quote", {
    quote_id: priced.quote_id,
    approved_amount: priced.total,
    confirmation_text: "yes",
  });
  const receipt = ok<{ approval_receipt_id: string }>(approval);

  // Move the price under the journey so there is something to catch.
  await graphql(
    endpoint,
    "mutation($id: ID!, $amount: String!) { setPrice(id: $id, amount: $amount) { id } }",
    { id: "NW-1001", amount: "699.00" },
  );

  const checkout = await env.guard.callTool("create_checkout", {
    quote_id: priced.quote_id,
    approval_receipt_id: receipt.approval_receipt_id,
  });

  await graphql(endpoint, "mutation { resetCatalogue }");

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

export async function POST(request: NextRequest): Promise<NextResponse> {
  loadDotEnv();
  const endpoint = endpointFor(request);

  let llm;
  try {
    llm = llmFromEnv();
  } catch (error) {
    return NextResponse.json({
      ok: false,
      reason: "no-model",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (!llm.isReal) {
    // Refusing rather than substituting a scripted stub. Inferring a mapping with a
    // canned reply would demonstrate nothing while looking like it had.
    return NextResponse.json({
      ok: false,
      reason: "no-model",
      error:
        "This needs a real model — writing the mapping is the whole point. " +
        "Set LLM_API_KEY, LLM_MODEL and LLM_BASE_URL.",
    });
  }

  try {
    await graphql(endpoint, "mutation { resetCatalogue }");

    // One real response, exactly what a new integrator would have to hand.
    const sample = await graphql(endpoint, QUERY, { ids: IDS });

    const handWrittenSchema = atThisServer(
      parseMerchantSchema(NORDWELL_MAPPING),
      endpoint,
    );

    const inferred = await inferMapping({
      llm,
      merchant: "nordwell-inferred",
      label: "Nordwell (mapping written by a model)",
      transport: handWrittenSchema.transport,
      sample,
      requestedIds: IDS,
    });

    if (!inferred.ok) {
      return NextResponse.json({
        ok: false,
        reason: "rejected",
        model: llm.name,
        problems: inferred.problems,
        proposal: inferred.proposal ?? null,
      });
    }

    const handWritten = await judge(handWrittenSchema, endpoint);
    const modelWritten = await judge(
      atThisServer(inferred.schema, endpoint),
      endpoint,
    );

    const agree =
      handWritten.total === modelWritten.total &&
      handWritten.blocked === modelWritten.blocked &&
      handWritten.fired.join() === modelWritten.fired.join() &&
      handWritten.withheld.join() === modelWritten.withheld.join();

    return NextResponse.json({
      ok: true,
      model: llm.name,
      mapping: {
        price: inferred.schema.product.price.path,
        unit: inferred.schema.product.price.unit,
        name: inferred.schema.product.name,
        stock: inferred.schema.inventory.available ?? null,
        vegan: inferred.schema.product.vegan?.path ?? null,
        allergens: inferred.schema.product.allergens?.path ?? null,
        priceVersion: inferred.schema.product.priceVersion ?? null,
      },
      priceForReview: inferred.priceForReview,
      capabilities: inferred.capabilities,
      derivedCapabilities: inferred.derivedCapabilities,
      notes: inferred.notes,
      handWritten,
      modelWritten,
      agree,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      reason: "error",
      endpoint,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
