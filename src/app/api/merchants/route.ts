import { type NextRequest, NextResponse } from "next/server";
import { loadDotEnv } from "@/lib/core/env";
import { formatMinor } from "@/lib/core/money";
import type { ToolResult } from "@/lib/guard/guard";
import { createEnvironment, createIntent } from "@/lib/harness";
import { MerchantAdapter } from "@/lib/merchant/adapter";
import { parseMerchantSchema } from "@/lib/merchant/mapping";
import { AdapterCatalogSource } from "@/lib/merchant/source";
import { transportFor } from "@/lib/merchant/transport";
import { NORDWELL_MAPPING } from "@/lib/merchants/nordwell";
import { CAPABILITIES, describeCapability } from "@/lib/policy/capabilities";

/**
 * Runs the twelve invariants against Nordwell, from the dashboard.
 *
 * The same journey `npm run demo:merchant` performs, reachable in a browser. The
 * portability claim is the hardest thing in this product to believe and was the easiest
 * to miss: it lived only in a terminal command, so anyone being shown the dashboard saw
 * twelve rules against one merchant and had to take the rest on trust.
 *
 * Deliberately fetches Nordwell over HTTP rather than calling its handler in-process.
 * Slower and more fragile, and the point: the claim is that the adapter reaches a
 * merchant the way a third party would. Short-circuiting that here would make the page
 * evidence for something weaker than what it says.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface Step {
  label: string;
  detail: string;
  tone: "ok" | "blocked" | "info";
}

function ok<T>(result: ToolResult): T {
  if (!result.ok) throw new Error(result.reason);
  return result.data as T;
}

/** Nordwell's own address, derived from this request rather than assumed. */
function endpointFor(request: NextRequest): string {
  const origin =
    request.headers.get("origin") ??
    `${request.nextUrl.protocol}//${request.headers.get("host") ?? request.nextUrl.host}`;
  return `${origin}/api/merchant/nordwell`;
}

async function mutate(
  endpoint: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json()) as { errors?: Array<{ message?: string }> };
  if (body.errors?.length) {
    throw new Error(body.errors[0]?.message ?? "nordwell rejected the mutation");
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  loadDotEnv();
  const endpoint = endpointFor(request);

  try {
    const schema = parseMerchantSchema({
      ...NORDWELL_MAPPING,
      transport: { ...NORDWELL_MAPPING.transport, endpoint },
    });

    // Start from a known catalogue, since a previous run may have re-priced.
    await mutate(endpoint, "mutation { resetCatalogue }", {});

    const ids = ["NW-1001", "NW-1005"];
    const adapter = new MerchantAdapter(schema, transportFor(schema));

    // -- what Nordwell can and cannot answer -------------------------------
    const capabilities = adapter.capabilities();
    const derived = new Set(adapter.derivedCapabilities());
    const capabilityRows = CAPABILITIES.map((capability) => ({
      capability,
      description: describeCapability(capability),
      available: capabilities.has(capability),
      derived: derived.has(capability),
    }));

    // -- a clean journey ---------------------------------------------------
    const clean = createEnvironment({});
    const cleanSource = new AdapterCatalogSource(adapter, clean.state);
    await cleanSource.prime(ids);
    clean.guard.setCatalogSource(cleanSource);
    clean.guard.beginIntent(
      createIntent(clean.ids, clean.clock, {
        runId: "nordwell-clean",
        utterance: "a coffee gift set under ₹1,500",
        maxBudget: 1500,
      }),
    );

    const catalogue = ids.map((id) => {
      const product = clean.state.getProduct(id);
      return {
        id,
        name: product?.name ?? "unknown",
        price: product ? formatMinor(product.priceMinor) : "—",
        stock: clean.state.freeStock(id),
        vegan: product?.vegan,
        allergens: product?.allergens,
        category: product?.category ?? "—",
      };
    });

    const steps: Step[] = [];
    const bundle = await clean.guard.callTool("create_bundle", {
      items: ids.map((id) => ({ product_id: id, quantity: 1 })),
    });
    steps.push({
      label: "create_bundle",
      detail: `${ids.length} lines, read from Nordwell over GraphQL`,
      tone: "ok",
    });

    const quote = await clean.guard.callTool("create_quote", {
      bundle_id: ok<{ bundle_id: string }>(bundle).bundle_id,
    });
    const priced = ok<{ quote_id: string; total: number }>(quote);
    steps.push({
      label: "create_quote",
      detail: `priced at ₹${priced.total} from decimal-string amounts`,
      tone: "ok",
    });

    const approval = await clean.guard.callTool("approve_quote", {
      quote_id: priced.quote_id,
      approved_amount: priced.total,
      confirmation_text: "yes, buy it",
    });
    const receiptId = ok<{ approval_receipt_id: string }>(approval)
      .approval_receipt_id;
    steps.push({ label: "approve_quote", detail: "buyer approved", tone: "ok" });

    const checkout = await clean.guard.callTool("create_checkout", {
      quote_id: priced.quote_id,
      approval_receipt_id: receiptId,
    });
    steps.push({
      label: "create_checkout",
      detail: checkout.ok ? "Guard allowed it" : `blocked — ${checkout.reason}`,
      tone: checkout.ok ? "ok" : "blocked",
    });

    const withheld = [
      ...new Set(
        clean.guard
          .allEvaluations()
          .flatMap((e) => e.capabilityGaps.map((g) => g.invariantId)),
      ),
    ];

    // -- the same journey, with Nordwell re-pricing under it ---------------
    const reprice = createEnvironment({});
    const repriceSource = new AdapterCatalogSource(adapter, reprice.state);
    await repriceSource.prime(ids);
    reprice.guard.setCatalogSource(repriceSource);
    reprice.guard.beginIntent(
      createIntent(reprice.ids, reprice.clock, {
        runId: "nordwell-reprice",
        utterance: "a coffee gift set",
        maxBudget: 1500,
      }),
    );

    const b2 = await reprice.guard.callTool("create_bundle", {
      items: [{ product_id: "NW-1001", quantity: 1 }],
    });
    const q2 = await reprice.guard.callTool("create_quote", {
      bundle_id: ok<{ bundle_id: string }>(b2).bundle_id,
    });
    const priced2 = ok<{ quote_id: string; total: number }>(q2);
    const a2 = await reprice.guard.callTool("approve_quote", {
      quote_id: priced2.quote_id,
      approved_amount: priced2.total,
      confirmation_text: "go ahead",
    });
    const receipt2 = ok<{ approval_receipt_id: string }>(a2).approval_receipt_id;

    await mutate(
      endpoint,
      "mutation($id: ID!, $amount: String!) { setPrice(id: $id, amount: $amount) { id } }",
      { id: "NW-1001", amount: "699.00" },
    );

    const c2 = await reprice.guard.callTool("create_checkout", {
      quote_id: priced2.quote_id,
      approval_receipt_id: receipt2,
    });

    const fired = [
      ...new Set(
        reprice.guard
          .recordedViolations()
          .concat(reprice.guard.recordedEscalations())
          .map((v) => v.invariantId),
      ),
    ];

    await mutate(endpoint, "mutation { resetCatalogue }", {});

    return NextResponse.json({
      ok: true,
      merchant: { label: schema.label, transport: schema.transport.kind, endpoint },
      capabilities: capabilityRows,
      capabilityCount: capabilities.size,
      capabilityTotal: CAPABILITIES.length,
      catalogue,
      clean: {
        steps,
        total: priced.total,
        allowed: checkout.ok,
        violations: clean.guard.recordedViolations().length,
        withheld,
      },
      reprice: {
        quotedAt: priced2.total,
        newPrice: 699,
        blocked: !c2.ok,
        reason: c2.ok ? null : c2.reason,
        fired,
      },
    });
  } catch (error) {
    // A failure here is a real result worth showing, not a blank page — the adapter
    // reaching a merchant is exactly what could break.
    return NextResponse.json(
      {
        ok: false,
        endpoint,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 200 },
    );
  }
}
