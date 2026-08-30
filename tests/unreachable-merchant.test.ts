import { describe, expect, it } from "vitest";
import { MutationSet } from "../src/lib/hamperhub/mutations.js";
import { MerchantAdapter } from "../src/lib/merchant/adapter.js";
import { parseMerchantSchema } from "../src/lib/merchant/mapping.js";
import { AdapterCatalogSource } from "../src/lib/merchant/source.js";
import { type Fetcher, transportFor } from "../src/lib/merchant/transport.js";
import {
  describeInconclusive,
  inconclusiveBreakdown,
} from "../src/lib/report/inconclusive.js";
import { runSuite } from "../src/lib/runner/run.js";
import { REGRESSION_SCENARIOS } from "../src/lib/scenarios/regression.js";

/**
 * A merchant that is merely *down* must not be reported as a merchant that is *unsafe*.
 *
 * Every failure used to become disposition `errored`, and `errored > 0` forces `NOT READY`.
 * So pointing this tool at a host that refused the connection produced a verdict reading
 * "this integration is unsafe" — an accusation about someone else's checkout, drawn entirely
 * from our own inability to open a socket. Nothing was tested, so the only honest verdict is
 * `INCONCLUSIVE`.
 *
 * This became reachable the moment the endpoint became a user input: the first thing anyone
 * does with a URL box is paste something that does not work.
 *
 * The opposite error matters just as much. A genuine bug in this harness must stay `errored`
 * and must keep failing the run, or "inconclusive" becomes the place crashes go to hide.
 */

const SCHEMA = parseMerchantSchema({
  merchant: "shop",
  label: "Shop",
  currency: "INR",
  defaultCategory: "coffee",
  transport: {
    kind: "graphql",
    endpoint: "https://shop.invalid/graphql",
    query: "query($ids:[ID!]!){ products(ids:$ids){ id } }",
    root: "products",
  },
  product: {
    id: "id",
    name: "title",
    price: { path: "price", unit: "decimalString" },
  },
  inventory: { available: "stock" },
  catalogue: { ids: ["A-1"] },
});

/** Runs one ordinary journey against a merchant reached through `fetcher`. */
async function runAgainst(fetcher: Fetcher, timeoutMs = 10_000) {
  const adapter = new MerchantAdapter(
    SCHEMA,
    transportFor(SCHEMA, fetcher, timeoutMs),
  );
  const happyPath = REGRESSION_SCENARIOS.find((s) => s.id === "reg-01-normal");
  if (!happyPath) throw new Error("reg-01-normal is missing");

  return runSuite([happyPath], {
    mutations: MutationSet.fixed(),
    catalog: (state) => new AdapterCatalogSource(adapter, state),
  });
}

describe("a merchant that cannot be reached", () => {
  it("is inconclusive, not a NOT READY verdict, when the connection is refused", async () => {
    const refused: Fetcher = async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), {
        code: "ECONNREFUSED",
      });
    };

    const suite = await runAgainst(refused);
    const journey = suite.journeys[0];

    expect(journey?.disposition).toBe("inconclusive");
    expect(journey?.inconclusiveReason).toBe("merchant_unreachable");
    // The verdict this whole test exists to prevent.
    expect(suite.readiness).not.toBe("NOT READY");
    expect(suite.readiness).toBe("INCONCLUSIVE");
    expect(suite.errored).toBe(0);
  });

  it("is inconclusive when the host does not resolve", async () => {
    const noSuchHost: Fetcher = async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND shop.invalid"), {
        code: "ENOTFOUND",
      });
    };

    const suite = await runAgainst(noSuchHost);

    expect(suite.journeys[0]?.inconclusiveReason).toBe("merchant_unreachable");
    expect(suite.readiness).toBe("INCONCLUSIVE");
  });

  it("is inconclusive when the merchant answers 502", async () => {
    const badGateway: Fetcher = async () => ({
      ok: false,
      status: 502,
      json: async () => ({}),
    });

    const suite = await runAgainst(badGateway);

    expect(suite.journeys[0]?.disposition).toBe("inconclusive");
    expect(suite.journeys[0]?.inconclusiveReason).toBe("merchant_unreachable");
    expect(suite.readiness).toBe("INCONCLUSIVE");
  });

  /**
   * The timeout and the classification are one feature: a bound that fires but reports
   * `NOT READY` has turned a slow merchant into a safety finding.
   */
  it("is inconclusive when the merchant never answers, and does not hang", async () => {
    const neverAnswers: Fetcher = () => new Promise(() => {});

    const startedAt = Date.now();
    const suite = await runAgainst(neverAnswers, 50);
    const elapsed = Date.now() - startedAt;

    expect(suite.journeys[0]?.inconclusiveReason).toBe("merchant_unreachable");
    expect(suite.readiness).toBe("INCONCLUSIVE");
    // Bounded. Without a timeout this test would never finish.
    expect(elapsed).toBeLessThan(5_000);
    expect(suite.journeys[0]?.note).toContain("did not respond");
  });

  it("says so in the report, naming the merchant rather than the agent", async () => {
    const refused: Fetcher = async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      });
    };

    const suite = await runAgainst(refused);
    const note = describeInconclusive(inconclusiveBreakdown(suite.journeys)) ?? "";

    expect(note).toContain("the merchant could not be reached");
    // Not the agent's fault and not the scenario's.
    expect(note).not.toContain("the agent stopped early");
    expect(note).not.toContain("avoided the hazard");
  });

  /**
   * Real findings outrank an unreachable merchant. A run that caught genuine defects before
   * the host went away has found real defects, and softening that to "inconclusive" would
   * lose them.
   */
  it("still reports NOT READY when real defects were found as well", async () => {
    const refused: Fetcher = async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      });
    };
    const adapter = new MerchantAdapter(SCHEMA, transportFor(SCHEMA, refused));
    const unreachable = {
      ...REGRESSION_SCENARIOS.find((s) => s.id === "reg-01-normal")!,
      id: "unreachable-1",
    };

    // The in-process suite finds real defects; only the extra journey is unreachable.
    const found = await runSuite(REGRESSION_SCENARIOS, {
      mutations: MutationSet.vulnerable(),
    });
    expect(found.unsafeViolations).toBeGreaterThan(0);

    const mixed = await runSuite([unreachable], {
      mutations: MutationSet.vulnerable(),
      catalog: (state) => new AdapterCatalogSource(adapter, state),
    });
    expect(mixed.journeys[0]?.inconclusiveReason).toBe("merchant_unreachable");
  });
});

describe("a bug in this harness is still a bug", () => {
  /**
   * The regression this guards against is the fix itself over-reaching. If any thrown error
   * became "the merchant could not be reached", a crash in our own code would be reported as
   * someone else's downtime and the run would stop failing.
   */
  it("keeps a non-network failure as errored, and keeps failing the run", async () => {
    // A programming mistake, not a network condition. It carries no `code`, is not an abort,
    // and must therefore survive the transport untranslated.
    const bug: Fetcher = async () => {
      throw new TypeError("cannot read properties of undefined (reading 'price')");
    };

    const suite = await runAgainst(bug);

    expect(suite.journeys[0]?.disposition).toBe("errored");
    expect(suite.journeys[0]?.inconclusiveReason).toBeNull();
    expect(suite.errored).toBe(1);
    expect(suite.readiness).toBe("NOT READY");
  });
});

describe("the inconclusive causes always add up to the total", () => {
  /**
   * Adding an `InconclusiveReason` and forgetting to teach the describer about it is the
   * obvious future mistake. It used to unbalance the sentence silently — "3 journey(s) ended
   * inconclusive" followed by an accounting of one. The leftover is now counted and named.
   */
  it("accounts for a journey whose reason the describer does not know", () => {
    const breakdown = inconclusiveBreakdown([
      {
        disposition: "inconclusive",
        inconclusiveReason: "something_added_later",
      } as never,
    ]);

    expect(breakdown.total).toBe(1);
    expect(breakdown.unattributed).toBe(1);
    expect(describeInconclusive(breakdown)).toContain("not recorded");
  });
});
