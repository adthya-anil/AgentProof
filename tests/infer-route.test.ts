import { describe, expect, it } from "vitest";
import { POST } from "../src/app/api/merchants/infer/route.js";

/**
 * The dashboard's mapping-inference route.
 *
 * The inference itself is covered by `infer-mapping.test.ts` against canned replies, and
 * by `npm run demo:infer` against a real model. What is only true of this route is that it
 * needs two things it does not control — a configured model and a reachable merchant — and
 * either can be absent.
 *
 * Both absences are results, not crashes. A page that renders blank because no key is set
 * is indistinguishable from one that is broken, and "no model configured" is the single
 * most useful thing it can say. The assertions here deliberately do not depend on whether
 * a key happens to exist in the environment, because that differs between a developer's
 * machine and CI and a test that flips between them is worse than none.
 */

function request(origin: string): Request {
  return new Request("http://test/api/merchants/infer", {
    method: "POST",
    headers: { origin, host: "test" },
  });
}

describe("the inference route reports what is missing rather than failing", () => {
  it("returns a named reason instead of throwing when it cannot proceed", async () => {
    // Port 1 is reserved and nothing listens there, so with a key configured this fails
    // at the merchant; without one it fails at the model. Either is a reason to show.
    const response = await POST(request("http://127.0.0.1:1") as never);
    const body = (await response.json()) as { ok: boolean; reason?: string };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(["no-model", "rejected", "error"]).toContain(body.reason);
  }, 60_000);

  it("carries an explanation with whatever reason it gives", async () => {
    /**
     * A reason code alone sends the reader to the source to find out what it means. The
     * panel needs something to print.
     */
    const response = await POST(request("http://127.0.0.1:1") as never);
    const body = (await response.json()) as {
      reason?: string;
      error?: string;
      problems?: string[];
    };

    const explained =
      Boolean(body.error) || (body.problems?.length ?? 0) > 0;
    expect(explained, `reason '${body.reason}' arrived with nothing to display`).toBe(
      true,
    );
  }, 60_000);
});
