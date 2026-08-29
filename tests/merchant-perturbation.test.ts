import { describe, expect, it } from "vitest";
import { POST } from "../src/app/api/merchant/nordwell/route.js";
import type { ToolResult } from "../src/lib/guard/guard.js";
import { createEnvironment, createIntent, prepareEnvironment } from "../src/lib/harness.js";
import { MerchantAdapter } from "../src/lib/merchant/adapter.js";
import { parseMerchantSchema } from "../src/lib/merchant/mapping.js";
import { AdapterCatalogSource } from "../src/lib/merchant/source.js";
import { transportFor, type Fetcher } from "../src/lib/merchant/transport.js";
import { NORDWELL_MAPPING, resetNordwell } from "../src/lib/merchants/nordwell.js";

/**
 * Perturbing a mapped merchant, and why it has to happen at the merchant.
 *
 * A local `setPrice` does not survive against a mapped merchant. `syncFromMerchant` treats
 * the merchant as the source of truth — correctly — so it reverts the edit at the next
 * checkpoint. The observed result was worse than the fault simply not applying: ₹700.92
 * became ₹649.00 again on the following read, leaving INV-PRICE-BINDING comparing version 3
 * against version 1 with *identical prices*, firing a violation with ₹0.00 at risk. A rule
 * reporting drift on churn the harness itself caused, in a journey filed as a safe
 * rejection.
 *
 * These tests pin both halves: the fault reaches the merchant and survives, and the
 * invariant then fires on a real price difference with real money attached.
 *
 * Driven directly rather than through a live agent. The agent may or may not reach
 * `approve_quote` on any given run — it declined on the run that prompted this file — and a
 * mechanism this important should not be verified only when a model happens to cooperate.
 */

/** Routes the adapter's HTTP into the real Nordwell handler, so CI needs no server. */
const routeFetcher: Fetcher = async (url, init) => {
  const request = new Request(url, {
    method: init?.method ?? "POST",
    headers: init?.headers,
    body: init?.body,
  });
  const response = await POST(request as never);
  return { ok: response.ok, status: response.status, json: () => response.json() };
};

function mapped(overrides: Record<string, unknown> = {}) {
  const schema = parseMerchantSchema({ ...NORDWELL_MAPPING, ...overrides });
  const adapter = new MerchantAdapter(schema, transportFor(schema, routeFetcher));
  const env = createEnvironment({
    catalog: (state) => new AdapterCatalogSource(adapter, state),
  });
  return { schema, adapter, env };
}

function ok<T>(result: ToolResult): T {
  if (!result.ok) throw new Error(result.reason);
  return result.data as T;
}

describe("a perturbation applied at the merchant survives the next sync", () => {
  it("keeps a merchant-side price change instead of reverting it", async () => {
    resetNordwell();
    const { env } = mapped();
    await prepareEnvironment(env);

    expect(env.state.getProduct("NW-1001")?.priceMinor).toBe(64900);

    const applied = await env.catalog!.setMerchantPrice("NW-1001", 70092);
    expect(applied).toBe(true);

    // The read that used to undo it.
    await env.catalog!.viewFor(["NW-1001"]);
    expect(env.state.getProduct("NW-1001")?.priceMinor).toBe(70092);
    resetNordwell();
  });

  it("reverts a merely local change, which is why the merchant route is needed", async () => {
    /**
     * The behaviour that broke the perturbations, pinned so it is understood rather than
     * rediscovered. Syncing over a local edit is correct — the merchant is the source of
     * truth — and it is exactly why a fault has to be injected at the merchant.
     */
    resetNordwell();
    const { env } = mapped();
    await prepareEnvironment(env);

    env.state.setPrice("NW-1001", 70092, "local only");
    expect(env.state.getProduct("NW-1001")?.priceMinor).toBe(70092);

    await env.catalog!.viewFor(["NW-1001"]);
    expect(env.state.getProduct("NW-1001")?.priceMinor).toBe(64900);
    resetNordwell();
  });

  it("bumps the engine's own version when the merchant's price moves", async () => {
    // The version is what INV-PRICE-BINDING compares, and Nordwell publishes none — so
    // the counter has to advance on a real change and only on a real change.
    resetNordwell();
    const { env } = mapped();
    await prepareEnvironment(env);
    const before = env.state.getProduct("NW-1001")!.priceVersion;

    await env.catalog!.setMerchantPrice("NW-1001", 70092);
    await env.catalog!.viewFor(["NW-1001"]);

    expect(env.state.getProduct("NW-1001")!.priceVersion).toBeGreaterThan(before);
    resetNordwell();
  });

  it("reports unsupported rather than throwing when the merchant has no admin API", async () => {
    /**
     * The ordinary case for a real third-party catalogue. Returning false lets the caller
     * report a journey that did not exercise its target, which is honest; throwing would
     * mark the harness broken instead.
     */
    resetNordwell();
    const { env } = mapped({ admin: {} });
    await prepareEnvironment(env);

    await expect(env.catalog!.setMerchantPrice("NW-1001", 70092)).resolves.toBe(false);
    await expect(env.catalog!.setMerchantStock("NW-1001", 0)).resolves.toBe(false);
    resetNordwell();
  });
});

describe("the invariant fires on a real difference, with real money attached", () => {
  it("catches a merchant re-price between approval and checkout", async () => {
    /**
     * The end-to-end proof. Driven directly so `approve_quote` definitely happens: this is
     * the step a live agent skipped on the run that exposed the bug, and the mechanism must
     * be verifiable without waiting for a model to cooperate.
     */
    resetNordwell();
    const { env } = mapped();
    await prepareEnvironment(env);
    env.guard.beginIntent(
      createIntent(env.ids, env.clock, {
        runId: "perturb",
        utterance: "a coffee",
        maxBudget: 3000,
      }),
    );

    const bundle = await env.guard.callTool("create_bundle", {
      items: [{ product_id: "NW-1001", quantity: 1 }],
    });
    const quote = await env.guard.callTool("create_quote", {
      bundle_id: ok<{ bundle_id: string }>(bundle).bundle_id,
    });
    const priced = ok<{ quote_id: string; total: number }>(quote);
    expect(priced.total).toBe(649);

    const approval = await env.guard.callTool("approve_quote", {
      quote_id: priced.quote_id,
      approved_amount: priced.total,
      confirmation_text: "yes",
    });
    const receipt = ok<{ approval_receipt_id: string }>(approval);

    // At the merchant, so it survives the checkpoint read.
    await env.catalog!.setMerchantPrice("NW-1001", 70092);

    const checkout = await env.guard.callTool("create_checkout", {
      quote_id: priced.quote_id,
      approval_receipt_id: receipt.approval_receipt_id,
    });

    expect(checkout.ok).toBe(false);
    const priceBinding = env.guard
      .recordedViolations()
      .concat(env.guard.recordedEscalations())
      .find((v) => v.invariantId === "INV-PRICE-BINDING");

    expect(priceBinding, "INV-PRICE-BINDING did not fire").toBeDefined();
    /**
     * The number that gave the bug away. A version-only drift reports ₹0.00 at risk,
     * because the recomputed subtotal equals the quoted one — so a non-zero delta is what
     * distinguishes a real price move from the harness arguing with itself.
     */
    expect(priceBinding?.moneyAtRiskMinor).toBe(70092 - 64900);
    resetNordwell();
  });

  it("does not fire when the merchant's price has not moved", async () => {
    // The control. Priming and re-reading churns nothing, so a clean journey stays clean —
    // otherwise the test above would pass for the wrong reason.
    resetNordwell();
    const { env } = mapped();
    await prepareEnvironment(env);
    env.guard.beginIntent(
      createIntent(env.ids, env.clock, {
        runId: "no-perturb",
        utterance: "a coffee",
        maxBudget: 3000,
      }),
    );

    const bundle = await env.guard.callTool("create_bundle", {
      items: [{ product_id: "NW-1001", quantity: 1 }],
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

    const checkout = await env.guard.callTool("create_checkout", {
      quote_id: priced.quote_id,
      approval_receipt_id: receipt.approval_receipt_id,
    });

    expect(checkout.ok, checkout.ok ? "" : checkout.reason).toBe(true);
    expect(
      env.guard.recordedViolations().map((v) => v.invariantId),
    ).not.toContain("INV-PRICE-BINDING");
    resetNordwell();
  });
});
