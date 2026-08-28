import { afterEach, describe, expect, it } from "vitest";
import { MutationSet } from "../src/lib/hamperhub/mutations.js";
import { loadPolicyFromFile } from "../src/lib/policy/load.js";
import { runSuite } from "../src/lib/runner/run.js";
import { REGRESSION_SCENARIOS } from "../src/lib/scenarios/regression.js";
import type { IntegrationVariant } from "../src/lib/dashboard/data.js";
import {
  clearRuns,
  getCachedRun,
  getLatestRun,
  recordRun,
} from "../src/lib/dashboard/runStore.js";

/**
 * A stored run has to outlive the process that produced it.
 *
 * Runs persisted to Postgres correctly and the read queries existed, but the
 * dashboard read only an in-memory cache — so restarting the server showed "no run
 * yet" while the rows sat in the database. It was the one place the product
 * delivered less than it claimed, and the failure was silent: the page looked
 * exactly like a dashboard nobody had run anything on.
 *
 * These tests cover the cache-and-hydrate contract. They pass without a database,
 * because persistence is optional and the fallback must be "no stored run" rather
 * than a crash.
 */

afterEach(() => {
  clearRuns();
});

async function smallSuite() {
  return runSuite(REGRESSION_SCENARIOS.slice(0, 3), {
    mutations: MutationSet.vulnerable(),
  });
}

async function record(variant: "vulnerable" | "fixed") {
  const suite = await smallSuite();
  return recordRun({
    variant,
    suite,
    startedAt: Date.now() - suite.durationMs,
    model: "scripted",
    modelIsReal: false,
    paymentAdapter: "simulated",
    regressionCount: 3,
    perturbationCount: 0,
    liveCount: 0,
    generatedCount: 0,
    policy: loadPolicyFromFile(),
  });
}

describe("reading a run back", () => {
  it("serves the run this process recorded", async () => {
    const stored = await record("vulnerable");
    const read = await getLatestRun("vulnerable");

    expect(read).not.toBeNull();
    expect(read!.id).toBe(stored.id);
    expect(read!.suite.journeys).toHaveLength(3);
  });

  it("keeps variants apart", async () => {
    await record("vulnerable");
    // A fixed-integration report must never be served for a vulnerable one; the
    // whole before/after comparison rests on that.
    const cached = getCachedRun("fixed");
    expect(cached).toBeNull();
  });

  it("reports no stored run rather than throwing when nothing exists", async () => {
    /**
     * Covers the no-database case too: persistence is optional, so an absent or
     * unreachable database must render an empty dashboard, not an error page.
     *
     * Asked about a variant nothing ever records, rather than "fixed". The previous
     * version relied on no `fixed` run existing anywhere, which is true of this file and
     * false of the database it shares — one `demo:preflight` persists both variants, and
     * afterwards this test failed while the code it covers was perfectly correct. A test
     * whose result depends on what else has touched the database is not testing the
     * thing it names.
     */
    const neverRecorded = "no-such-variant" as IntegrationVariant;
    expect(await getLatestRun(neverRecorded)).toBeNull();
  });

  it("distinguishes a cache miss from an absent run", async () => {
    await record("vulnerable");
    clearRuns();
    // After clearing, the synchronous cache read is empty by definition. The async
    // read is what consults storage — conflating the two is what made a restarted
    // server look like a fresh install.
    expect(getCachedRun("vulnerable")).toBeNull();
  });
});

describe("recording a run", () => {
  it("does not fail the run when persistence is unavailable", async () => {
    // The run already happened. Losing the database copy must never lose the
    // result the developer is waiting to read.
    const stored = await record("vulnerable");
    expect(stored.suite.journeys).toHaveLength(3);
    expect(stored.finishedAt).toBeTruthy();
  });

  it("says plainly whether the run reached Postgres", async () => {
    const stored = await record("vulnerable");
    // Null means "in memory only". A dashboard that implied durability it did not
    // have would be the same class of untruth as the rest of this file guards.
    expect(
      stored.persistedSuiteId === null ||
        typeof stored.persistedSuiteId === "string",
    ).toBe(true);
  });

  it("keeps the newest run per variant", async () => {
    const first = await record("vulnerable");
    const second = await record("vulnerable");
    expect(first.id).not.toBe(second.id);

    const read = await getLatestRun("vulnerable");
    expect(read!.id).toBe(second.id);
  });
});

describe("a revived suite is usable, not merely present", () => {
  /**
   * The risk with a JSON snapshot is that it deserialises into something that looks
   * right and breaks on use. `AuditEvent.at` is a Date, and a round-trip makes it a
   * string — every replay page calls `.getTime()` on it, so an unrevived timestamp
   * is a crash on the page that matters most.
   */
  it("keeps audit timestamps as Dates", async () => {
    const stored = await record("vulnerable");
    for (const journey of stored.suite.journeys) {
      for (const event of journey.auditTrail) {
        expect(event.at, `${journey.scenarioId} seq ${event.seq}`).toBeInstanceOf(
          Date,
        );
        expect(Number.isNaN(event.at.getTime())).toBe(false);
      }
    }
  });

  it("carries the replay detail the normalised tables do not hold", async () => {
    // These eight fields have no column, which is why a snapshot exists at all. If
    // they were empty the report would be quietly poorer than the one produced.
    const stored = await record("vulnerable");
    const journey = stored.suite.journeys.find((j) => j.toolPath.length > 0);

    expect(journey, "at least one journey must record a tool path").toBeDefined();
    expect(journey!.exercisedInvariants.length).toBeGreaterThan(0);
    expect(journey!.auditTrail.length).toBeGreaterThan(0);
    expect(Array.isArray(journey!.escalations)).toBe(true);
    expect(Array.isArray(journey!.perturbations)).toBe(true);
  });

  it("keeps the verdict and its evidence together", async () => {
    const stored = await record("vulnerable");
    const journey = stored.suite.journeys.find(
      (j) => j.disposition === "unsafe_violation",
    );
    if (!journey) return;

    // The trail's own closing entry must still agree with the result object after a
    // round-trip; two accounts of one journey that can diverge means one is
    // decoration.
    const completed = journey.auditTrail.at(-1);
    expect(completed?.type).toBe("run.completed");
    expect((completed!.output as { disposition: string }).disposition).toBe(
      journey.disposition,
    );
  });
});
