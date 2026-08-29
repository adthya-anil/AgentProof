import type { Environment } from "../harness.js";
import type { ToolCaller, ToolResult } from "../guard/guard.js";
import type { ToolName } from "../hamperhub/tools.js";
import { formatMinor } from "../core/money.js";
import type { Interference } from "../scenarios/types.js";

/**
 * Applies a scenario's interference at the moment its trigger tool succeeds.
 *
 * Sits between the agent and the Guard so the change lands *after* the agent has
 * committed to something and *before* its next call — a price rising between
 * approval and checkout, stock vanishing after a quote is agreed. Every individual
 * call the agent makes is still valid; only the transaction as a whole is unsafe.
 *
 * Keyed to a tool rather than a script position because the same declaration has
 * to work for a fixed sequence and for a live model that picks its own route. That
 * is the whole reason this exists: the interference used to be written into each
 * scenario's `execute` body, which a live agent replaces wholesale, so the live
 * twins carried invariant labels with no mechanism behind them.
 */
export class InterferingToolCaller implements ToolCaller {
  private fired = false;
  private failure: string | null = null;
  private effect: string | null = null;

  constructor(
    private readonly inner: ToolCaller,
    private readonly plan: Interference,
    private readonly env: Environment,
  ) {}

  async callTool(
    name: ToolName,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const result = await this.inner.callTool(name, args);

    // Once only, and only after the trigger actually succeeded. Firing on a
    // failed call would change the world in response to something that did not
    // happen.
    if (!this.fired && name === this.plan.afterTool && result.ok) {
      /**
       * Awaited, and only marked as fired once it has actually landed.
       *
       * `apply` became async when perturbing a mapped merchant became a network write, and
       * this call was left un-awaited. The consequences were both subtle and severe: the
       * write raced the agent's very next tool call, so a price rise sometimes reached the
       * merchant before checkout and sometimes did not, and the same scenario alternated
       * between catching a violation and reporting a clean pass with nothing to show for it.
       * An intermittent test that reports success when it loses the race is worse than one
       * that fails, because the failure looks like a result.
       *
       * `fired` moves after the await for the same reason: a write that did not happen must
       * not leave the journey claiming its fault was applied.
       */
      try {
        this.effect = await describeEffect(this.env, () => this.plan.apply(this.env));
        this.fired = true;
      } catch (error) {
        /**
         * A merchant that cannot be perturbed is an ordinary fact about a third-party
         * catalogue, not a broken harness. Caught so the journey reports that its fault
         * never fired — which the runner turns into `inconclusive` — rather than `errored`.
         */
        this.failure = error instanceof Error ? error.message : String(error);
      }
    }

    return result;
  }

  /** True when the change was actually applied. Drives the honest verdict. */
  applied(): boolean {
    return this.fired;
  }

  /**
   * Why the change could not be applied, when it could not.
   *
   * Reported so "this journey did not exercise its target invariant" can say whether the
   * agent never reached the trigger or the merchant refused to be perturbed — two very
   * different facts that otherwise look identical in a report.
   */
  failureReason(): string | null {
    return this.failure;
  }

  /** What the fault changed, in words, once it has fired. */
  appliedEffect(): string | null {
    return this.effect;
  }
}

/**
 * Runs a fault and reports which catalogue values it moved.
 *
 * Diffing before and after rather than asking the interference to describe itself: a
 * description the fault writes about its own intent can drift from what it did, and the
 * thing worth recording is the change that actually landed. Reads local state after the
 * next sync would have happened, so a merchant-side write shows up as the price the engine
 * will actually compare against.
 */
async function describeEffect(
  env: { state: { listProducts(): Array<{ id: string; name: string; priceMinor: number }>; freeStock(id: string): number };
         catalog?: { viewFor(ids: readonly string[]): Promise<unknown> } },
  run: () => void | Promise<void>,
): Promise<string> {
  const before = new Map(
    env.state.listProducts().map((p) => [p.id, { price: p.priceMinor, stock: env.state.freeStock(p.id), name: p.name }]),
  );

  await run();

  // Pull the merchant's current answer in, so a remote write is visible here too.
  if (env.catalog) {
    await env.catalog.viewFor([...before.keys()]).catch(() => undefined);
  }

  const changes: string[] = [];
  for (const product of env.state.listProducts()) {
    const was = before.get(product.id);
    if (!was) continue;
    if (was.price !== product.priceMinor) {
      changes.push(
        `${product.name} ${formatMinor(was.price)} → ${formatMinor(product.priceMinor)}`,
      );
    }
    const stock = env.state.freeStock(product.id);
    if (was.stock !== stock) {
      changes.push(`${product.name} stock ${was.stock} → ${stock}`);
    }
  }

  return changes.length > 0 ? changes.join("; ") : "no catalogue value changed";
}
