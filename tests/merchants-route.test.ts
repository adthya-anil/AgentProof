import { describe, expect, it } from "vitest";
import { POST } from "../src/app/api/merchants/route.js";

/**
 * The dashboard's second-merchant run.
 *
 * The journey it performs is already covered by `second-merchant.test.ts`, which calls
 * Nordwell's handler directly. What is only true of this route is that it fetches
 * Nordwell over HTTP — deliberately, since the claim being demonstrated is that the
 * adapter reaches a merchant the way a third party would. That also means it can fail
 * for reasons the rest of the suite never sees: a wrong origin, a refused connection, a
 * server that is not up.
 *
 * So this covers the failure path. A page that renders blank when the merchant is
 * unreachable would be worse than one that says so, and "the adapter could not reach the
 * merchant" is the single most informative thing this page can report.
 */

function request(origin: string): Request {
  return new Request("http://test/api/merchants", {
    method: "POST",
    headers: { origin, host: "test" },
  });
}

describe("the merchants route reports failure rather than breaking the page", () => {
  it("returns ok:false with the reason when Nordwell cannot be reached", async () => {
    // Port 1 is reserved and nothing listens there, so the fetch is refused rather
    // than hanging.
    const response = await POST(request("http://127.0.0.1:1") as never);
    const body = (await response.json()) as { ok: boolean; error?: string };

    // Status 200 on purpose: the request succeeded, the merchant is what failed, and
    // the client renders that as a result instead of an error boundary.
    expect(response.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.error).toBeTruthy();
  }, 30_000);

  it("names the endpoint it tried, so a wrong origin is diagnosable", async () => {
    /**
     * The likeliest real failure is not a dead merchant but a bad address — a proxy
     * rewriting the origin, or a deployment where the app cannot reach itself. Without
     * the URL in the response, that is indistinguishable from the service being down.
     */
    const response = await POST(request("http://127.0.0.1:1") as never);
    const body = (await response.json()) as { endpoint?: string };
    expect(body.endpoint).toBe("http://127.0.0.1:1/api/merchant/nordwell");
  }, 30_000);
});
