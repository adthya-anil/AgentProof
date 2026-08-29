import { assignRoles, llmPoolFromEnv } from "../lib/agent/factory.js";
import { loadDotEnv } from "../lib/core/env.js";
import { formatMinor } from "../lib/core/money.js";
import { MutationSet } from "../lib/hamperhub/mutations.js";
import { MerchantAdapter } from "../lib/merchant/adapter.js";
import { parseMerchantSchema, type MerchantSchema } from "../lib/merchant/mapping.js";
import { AdapterCatalogSource } from "../lib/merchant/source.js";
import { transportFor } from "../lib/merchant/transport.js";
import { NORDWELL_MAPPING } from "../lib/merchants/nordwell.js";
import { createEnvironment } from "../lib/harness.js";
import { loadPolicyFromFile } from "../lib/policy/load.js";
import { assembleSuite } from "../lib/scenarios/index.js";
import { runSuite } from "../lib/runner/run.js";

/**
 * A real preflight run against a mapped merchant.
 *
 * The mapping existed so the invariants could read someone else's catalogue, and that was
 * demonstrated with two journeys. Two journeys is not a preflight. The point of mapping a
 * merchant is to *test* it — to answer "is this shop safe for an autonomous buyer" — and
 * until now only HamperHub could be asked that.
 *
 * What runs here are the same agent-driven goals HamperHub gets: a real model, its own
 * choice of tools, no script. They work against any merchant because they were always
 * natural language — "a nice coffee hamper under ₹1,500" names no product id. The missing
 * pieces were a way for the agent to browse a mapped catalogue and a seam to point a run
 * at one.
 *
 * The twelve deterministic regression scenarios stay out, and that is deliberate rather
 * than unfinished: they name exact products — `p-coffee-arabica` three times over — and
 * they earn their keep by being precise reproductions against a known catalogue. Rewriting
 * them to pick "something cheap" would blur the thing they exist to pin down.
 *
 *   npm run build && npm start
 *   npm run demo:merchant-preflight
 */

const BASE = process.env.AGENTPROOF_BASE_URL ?? "http://127.0.0.1:3000";
const ENDPOINT = `${BASE}/api/merchant/nordwell`;

function atThisServer(schema: MerchantSchema): MerchantSchema {
  return { ...schema, transport: { ...schema.transport, endpoint: ENDPOINT } as never };
}

async function main(): Promise<void> {
  loadDotEnv();

  const pool = llmPoolFromEnv().filter((llm) => llm.isReal);
  if (pool.length === 0) {
    console.error(
      "\n  This needs a real model: the journeys are live agent runs, and a scripted\n" +
        "  stand-in would shop a catalogue it was never shown.\n",
    );
    process.exitCode = 1;
    return;
  }

  const schema = atThisServer(parseMerchantSchema(NORDWELL_MAPPING));
  const adapter = new MerchantAdapter(schema, transportFor(schema));

  console.log(`\nPreflight against a mapped merchant — ${schema.label}\n`);

  // Confirm the merchant can be browsed before spending tokens on it.
  let ids: string[];
  try {
    ids = await adapter.listIds();
  } catch (error) {
    console.error(
      `\n  Could not browse the catalogue: ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const capabilities = adapter.capabilities();
  console.log(`  Merchant        ${schema.label} (${schema.transport.kind})`);
  console.log(`  Catalogue       ${ids.length} products, browsed over the wire`);
  console.log(`  Capabilities    ${capabilities.size} of 8`);
  console.log(`  Models          ${pool.map((m) => m.name).join(" · ")}`);

  // What the agent will actually see when it searches.
  const probe = createEnvironment({});
  const source = new AdapterCatalogSource(adapter, probe.state);
  await source.prime(ids);
  const shelves = probe.state.listProducts();
  console.log(`\n  What the agent finds on the shelves:`);
  for (const product of shelves.slice(0, 8)) {
    console.log(
      `    ${product.id.padEnd(10)}${formatMinor(product.priceMinor).padStart(10)}  ` +
        `stock ${String(probe.state.freeStock(product.id)).padStart(3)}  ` +
        `${product.category}`,
    );
  }

  /**
   * The whole agent-driven half, composed the same way a real preflight composes it.
   *
   * Hand-assembling only the live goals left two families out for no reason: the four
   * transport perturbations are faults in the *transport* — a duplicated delivery, a
   * replayed approval — and name no products at all, and the adversary's generated goals
   * are natural language. Both were always portable; they were simply not wired in, so
   * Nordwell ran 11 journeys where it could run 18.
   *
   * `assembleSuite` with mode "agent" drops the twelve deterministic reproductions, which
   * is the one family that genuinely cannot port: they name exact products and earn their
   * keep as precise sequences against a known catalogue.
   */
  /**
   * Buyers shop; the adversary writes. Passing the whole pool broke that.
   *
   * `assignRoles` already separates them, and handing `llms: pool` to the live half
   * ignored it — the adversary drove seven buyer journeys on top of designing the goals,
   * which is precisely the duplication having two models is meant to replace. The main
   * preflight route got this right; this script did not.
   */
  const { adversary, buyers } = assignRoles(pool, "split");
  const composed = await assembleSuite({
    mode: "agent",
    llm: pool[0]!,
    llms: buyers.length > 0 ? buyers : pool,
    ...(adversary ? { adversary } : {}),
    policy: loadPolicyFromFile(),
    maxToolCalls: 24,
    /**
     * Five, not the default nine, to keep the suite at twenty journeys.
     *
     * 4 perturbation + 11 live + 5 generated = 20. A run is only worth what someone will
     * wait for: at a minute or two of real model calls per journey, a suite that takes
     * half an hour gets skipped, and a skipped suite detects nothing.
     */
    generatedCount: 5,
  });
  const scenarios = composed.scenarios;

  console.log(
    `  Composition     ${composed.perturbationCount} perturbation · ` +
      `${composed.liveCount} live goal · ${composed.generatedCount} adversary-written`,
  );
  console.log(`  Adversary       ${composed.roles.adversary}`);
  console.log(`  Buyers          ${composed.roles.buyers.join(" · ")}`);

  /**
   * Both integration variants, against the same mapped merchant.
   *
   * The mutations are defects in the *integration* — the checkout code — not in the
   * merchant's catalogue, so they apply just as well when the catalogue is someone
   * else's. Running only the fixed variant produces a clean bill of health with nothing
   * to compare it to, and a preflight whose verdict cannot move is not a verdict.
   */
  /**
   * One variant by default, both only when asked.
   *
   * The question a mapped merchant poses is "is this integration safe against this shop",
   * which one run answers. The second variant answers a different question — does our own
   * detector still work — and HamperHub already answers that far more cheaply, with
   * twelve deterministic reproductions instead of twenty live journeys. Running both
   * doubled the wall clock to prove something already proven elsewhere.
   */
  const variants = process.env.AGENTPROOF_COMPARE_VARIANTS === "1"
    ? (["vulnerable", "fixed"] as const)
    : (["fixed"] as const);

  console.log(
    `\n  Running ${scenarios.length} live-agent journeys` +
      `${variants.length > 1 ? " per variant" : ""}. This takes minutes.\n`,
  );

  const results: Array<{ variant: string; suite: Awaited<ReturnType<typeof runSuite>> }> = [];
  for (const variant of variants) {
    console.log(`  ── ${variant.toUpperCase()} integration, fronting ${schema.label}`);
    const suite = await runSuite(scenarios, {
      mutations: variant === "fixed" ? MutationSet.fixed() : MutationSet.vulnerable(),
      // A factory, so each journey's source is bound to that journey's own state. One
      // shared instance syncs the merchant into a state nobody owns, and every journey
      // then fails price binding against a catalogue it was never priced from.
      catalog: (state) => new AdapterCatalogSource(adapter, state),
      onScenarioStart: (scenario, index, total) =>
        console.log(`     [${index + 1}/${total}] ${scenario.id}`),
    });
    results.push({ variant, suite });
  }

  for (const { variant, suite } of results) {
    console.log(`\n  ── ${variant.toUpperCase()}\n`);
    for (const journey of suite.journeys) {
      const fired = journey.firedInvariants.join(", ") || "—";
      console.log(
        // 36, because an adversary-written id like gen-vegan-coffee-hamper-under-2000
        // overran 28 and collided with the next column.
        `    ${journey.disposition.padEnd(17)}${journey.scenarioId.padEnd(36)}${fired}`,
      );
    }
    console.log(
      `\n    passed ${suite.passed} · safely rejected ${suite.safelyRejected} · ` +
        `escalated ${suite.escalated} · unsafe ${suite.unsafeViolations} · ` +
        `inconclusive ${suite.inconclusive}`,
    );
    console.log(
      `    money at risk ${formatMinor(suite.moneyAtRiskMinor)} · ` +
        `readiness ${suite.readiness} · ` +
        `audit chain ${suite.auditChainOk ? "intact" : "BROKEN"}`,
    );
  }

  const suite = results[results.length - 1]!.suite;
  const vulnerable = results.length > 1 ? results[0]!.suite : null;

  if (suite.inconclusive === suite.journeys.length) {
    console.error(
      "\n✗ Every journey was inconclusive — nothing was verified. Usually the agent\n" +
        "  could not find products, which means the catalogue was not primed.\n",
    );
    process.exitCode = 1;
    return;
  }

  const verdictMoved =
    vulnerable !== null &&
    vulnerable.unsafeViolations > 0 &&
    suite.unsafeViolations === 0;

  console.log();
  if (!vulnerable) {
    console.log(
      `✓ ${suite.journeys.length} live-agent journeys against a merchant behind a mapping,\n` +
        `  using the same twelve invariants and readiness rule HamperHub is judged by.\n` +
        `  Set AGENTPROOF_COMPARE_VARIANTS=1 to also run the vulnerable integration and\n` +
        `  watch the verdict move — that costs twice the time to re-prove something the\n` +
        `  HamperHub suite already establishes deterministically.\n`,
    );
  } else if (verdictMoved) {
    console.log(
      `✓ ${suite.journeys.length} live-agent journeys per variant against a merchant behind\n` +
        `  a mapping. The verdict moved — ${vulnerable.unsafeViolations} unsafe violations on the vulnerable\n` +
        `  integration, ${suite.unsafeViolations} on the fixed one — using the same twelve invariants and the\n` +
        `  same readiness rule HamperHub is judged by.\n`,
    );
  } else {
    console.log(
      `  Ran ${suite.journeys.length} journeys per variant. The verdict did not move\n` +
        `  (${vulnerable.unsafeViolations} unsafe vulnerable, ${suite.unsafeViolations} fixed), so this run does not\n` +
        `  demonstrate detection — a live agent may simply not have walked into the\n` +
        `  seeded defects. Reported rather than dressed up.\n`,
    );
  }
}

void main().catch((error) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
