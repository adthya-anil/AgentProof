import { type NextRequest } from "next/server";
import { assignRoles, llmPoolFromEnv } from "@/lib/agent/factory";
import { loadDotEnv } from "@/lib/core/env";
import { formatMinor } from "@/lib/core/money";
import { createEnvironment } from "@/lib/harness";
import { MutationSet } from "@/lib/hamperhub/mutations";
import { MerchantAdapter } from "@/lib/merchant/adapter";
import { inferMapping } from "@/lib/merchant/infer";
import { type MerchantSchema, parseMerchantSchema } from "@/lib/merchant/mapping";
import { AdapterCatalogSource } from "@/lib/merchant/source";
import { merchantTimeoutMs, transportFor } from "@/lib/merchant/transport";
import { NORDWELL_MAPPING } from "@/lib/merchants/nordwell";
import { CAPABILITIES, describeCapability } from "@/lib/policy/capabilities";
import { loadPolicyFromFile } from "@/lib/policy/load";
import { runSuite } from "@/lib/runner/run";
import {
  describeInconclusive,
  inconclusiveBreakdown,
} from "@/lib/report/inconclusive";
import { assembleSuite } from "@/lib/scenarios/index";

/**
 * The whole claim, end to end: a third-party catalogue, mapped by a model, then tested.
 *
 * What stood here before was two hardcoded journeys — `create_bundle(NW-1001, NW-1005)`
 * followed by three fixed calls — dressed up as a demonstration. It proved the mapping
 * could read fields. It did not test Nordwell, and the inferred mapping was never used for
 * anything except agreeing with the hand-written one on that same four-step script. Three
 * disconnected pieces where the product is one line:
 *
 *   an unfamiliar catalogue → a model writes the mapping → validation accepts or refuses
 *   it → real agents shop the merchant through it → the same twelve invariants and the
 *   same readiness rule deliver a verdict
 *
 * Nothing here is scripted. The agent chooses its own products from whatever the merchant
 * turns out to sell, and no product id appears in this file.
 *
 * Streamed, because twenty live-agent journeys take minutes and a plain POST would leave
 * the browser hanging until it gave up. The pattern is the preflight route's, for the same
 * reason.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 1800;

/** Nordwell's own address. Resolved once, from this request. */
function endpointFor(request: NextRequest): string {
  const origin =
    request.headers.get("origin") ??
    `${request.nextUrl.protocol}//${request.headers.get("host") ?? request.nextUrl.host}`;
  return `${origin}/api/merchant/nordwell`;
}

function atEndpoint(schema: MerchantSchema, endpoint: string): MerchantSchema {
  return { ...schema, transport: { ...schema.transport, endpoint } as never };
}

/**
 * The reset and sample reads, bounded like everything else.
 *
 * This helper predates the transport and calls `fetch` directly, so it did not inherit the
 * transport's timeout. It runs *before* any journey — reading one response to infer the
 * mapping — so an unresponsive endpoint hung here, before a single event reached the
 * browser. The page showed a spinner with nothing behind it.
 */
async function graphql(
  endpoint: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(merchantTimeoutMs()),
  });
  const body = (await response.json()) as { errors?: Array<{ message?: string }> };
  if (body.errors?.length) {
    throw new Error(body.errors[0]?.message ?? "the merchant rejected the request");
  }
  return body;
}

/** The read a new integrator would start from: one response, shape unknown. */
const SAMPLE_QUERY = `query Sample {
  products {
    id
    title
    collection
    pricing { unit { amount currencyCode } floor { amount } }
    availability { quantity }
    dietary { contains tags }
    giftable
  }
}`;

export async function POST(request: NextRequest): Promise<Response> {
  loadDotEnv();
  const endpoint = endpointFor(request);
  const url = new URL(request.url);
  /**
   * Eight goals or twenty. Twenty is the real suite; eight exists because a demonstration
   * someone is watching has a different tolerance for waiting than a nightly run.
   */
  const quick = url.searchParams.get("size") === "quick";

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };

      try {
        const pool = llmPoolFromEnv().filter((llm) => llm.isReal);
        if (pool.length === 0) {
          /**
           * Refused rather than substituted. A scripted stand-in cannot infer a mapping,
           * and cannot shop a catalogue it was never shown — running it would produce a
           * page that looked like this had worked.
           */
          send({
            kind: "error",
            stage: "model",
            message:
              "This needs a real model: it writes the mapping and drives the agents. " +
              "Set LLM_API_KEY, LLM_MODEL and LLM_BASE_URL.",
          });
          controller.close();
          return;
        }

        const { adversary, buyers } = assignRoles(pool, "split");
        send({
          kind: "start",
          endpoint,
          adversary: adversary?.name ?? null,
          buyers: buyers.map((b) => b.name),
        });

        // -- 1. read the merchant, knowing nothing about it -------------------
        send({ kind: "phase", phase: "sample", label: "Reading one response from the merchant" });
        await graphql(endpoint, "mutation { resetCatalogue }");
        const sample = await graphql(endpoint, SAMPLE_QUERY);

        // -- 2. a model writes the mapping ------------------------------------
        send({
          kind: "phase",
          phase: "infer",
          label: `Asking ${pool[0]!.name} where each field lives`,
        });

        const transport = atEndpoint(
          parseMerchantSchema(NORDWELL_MAPPING),
          endpoint,
        ).transport;

        const declared = atEndpoint(parseMerchantSchema(NORDWELL_MAPPING), endpoint);
        const inferred = await inferMapping({
          llm: pool[0]!,
          merchant: "third-party",
          label: "Third-party catalogue (mapped by a model)",
          transport,
          sample,
          requestedIds: [],
          // How to browse it and whether it can be perturbed are configuration, not things
          // a model can read off one response.
          base: declared,
        });

        if (!inferred.ok) {
          // A refused proposal is the mechanism working, and the run stops here rather
          // than testing a merchant through a mapping nothing could verify.
          send({
            kind: "rejected",
            problems: inferred.problems,
            message:
              "The mapping was refused, so nothing was run through it. A mapping that " +
              "cannot build a product from a real response would produce confident " +
              "verdicts about the wrong fields.",
          });
          controller.close();
          return;
        }

        /**
         * Configuration comes through `base`; only the field mappings are inferred.
         *
         * This route used to patch individual fields back onto the inferred schema, which
         * dropped whichever one nobody remembered. `admin` was the one that got missed, so a
         * merchant with working mutations reported that its prices could not be moved and
         * two perturbation journeys came back untestable — with a plausible message rather
         * than an error.
         */
        const withCatalogue = atEndpoint(inferred.schema, endpoint);
        const adapter = new MerchantAdapter(withCatalogue, transportFor(withCatalogue));
        const capabilities = adapter.capabilities();
        const derived = new Set(adapter.derivedCapabilities());

        send({
          kind: "mapping",
          paths: {
            id: withCatalogue.product.id,
            name: withCatalogue.product.name,
            price: withCatalogue.product.price.path,
            unit: withCatalogue.product.price.unit,
            stock: withCatalogue.inventory.available ?? null,
            vegan: withCatalogue.product.vegan?.path ?? null,
            allergens: withCatalogue.product.allergens?.path ?? null,
          },
          priceForReview: inferred.priceForReview,
          notes: inferred.notes,
          capabilities: CAPABILITIES.map((capability) => ({
            capability,
            description: describeCapability(capability),
            available: capabilities.has(capability),
            derived: derived.has(capability),
          })),
          capabilityCount: capabilities.size,
          capabilityTotal: CAPABILITIES.length,
        });

        // -- 3. browse the shop through the model's mapping -------------------
        send({ kind: "phase", phase: "browse", label: "Browsing the catalogue" });
        const ids = await adapter.listIds();

        const probe = createEnvironment({});
        await new AdapterCatalogSource(adapter, probe.state).prime(ids);
        send({
          kind: "catalogue",
          products: probe.state.listProducts().map((product) => ({
            id: product.id,
            name: product.name,
            price: formatMinor(product.priceMinor),
            stock: probe.state.freeStock(product.id),
            vegan: product.vegan,
            allergens: product.allergens,
            category: product.category,
          })),
        });

        // -- 4. real agents shop it, judged by the same policy ---------------
        const composed = await assembleSuite({
          mode: "agent",
          llm: pool[0]!,
          llms: buyers.length > 0 ? buyers : pool,
          ...(adversary ? { adversary } : {}),
          policy: loadPolicyFromFile(),
          maxToolCalls: 24,
          generatedCount: quick ? 2 : 5,
          includePerturbations: !quick,
          ...(quick ? { liveGoals: ["reg-01-normal", "reg-07-price-changed", "reg-09-discount-stacking", "reg-10-unknown-allergen", "reg-12-over-budget", "reg-03-over-max-amount"] } : {}),
        });

        send({
          kind: "assembled",
          total: composed.scenarios.length,
          perturbations: composed.perturbationCount,
          live: composed.liveCount,
          generated: composed.generatedCount,
        });

        const suite = await runSuite(composed.scenarios, {
          mutations: MutationSet.fixed(),
          // A factory: each journey's source must be bound to that journey's own state, or
          // quotes get priced from one catalogue and verified against another.
          catalog: (state) => new AdapterCatalogSource(adapter, state),
          onScenarioStart: (scenario, index, total) =>
            send({ kind: "scenario_start", id: scenario.id, title: scenario.title, index, total }),
          onJourney: (journey, index, total) =>
            send({
              kind: "journey",
              index,
              total,
              id: journey.scenarioId,
              title: journey.title,
              model: journey.model,
              disposition: journey.disposition,
              note: journey.note,
              fired: journey.firedInvariants,
              withheld: journey.withheldInvariants,
              moneyAtRisk: formatMinor(journey.moneyAtRiskMinor),
              toolPath: journey.toolPath,
            }),
        });

        /**
         * Which rules never ran, across the whole suite.
         *
         * Reported beside the verdict because "no unsafe violations" over eleven rules is
         * not the same claim as over twelve, and a reader cannot tell without this.
         */
        const withheld = [
          ...new Set(suite.journeys.flatMap((j) => j.withheldInvariants)),
        ].sort();

        send({
          kind: "done",
          summary: {
            journeys: suite.journeys.length,
            passed: suite.passed,
            safelyRejected: suite.safelyRejected,
            escalated: suite.escalated,
            unsafeViolations: suite.unsafeViolations,
            inconclusive: suite.inconclusive,
            errored: suite.errored,
            moneyAtRisk: formatMinor(suite.moneyPreventedMinor),
            moneyNotPrevented:
              suite.moneyNotPreventedMinor > 0
                ? formatMinor(suite.moneyNotPreventedMinor)
                : null,
            decidedJourneys: suite.decidedJourneys,
            // The reason each inconclusive journey proved nothing, computed where the
            // journeys are, so the page cannot invent a cause it has no data for.
            inconclusiveNote: describeInconclusive(
              inconclusiveBreakdown(suite.journeys),
            ),
            readiness: suite.readiness,
            auditChainOk: suite.auditChainOk,
            durationMs: suite.durationMs,
            withheld,
          },
        });
      } catch (error) {
        send({
          kind: "error",
          stage: "run",
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by a disconnecting client.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
