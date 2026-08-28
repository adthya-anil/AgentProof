import type { Environment } from "../harness.js";
import type { ToolCaller, ToolResult } from "../guard/guard.js";
import type { ToolName } from "../hamperhub/tools.js";
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
      this.fired = true;
      this.plan.apply(this.env);
    }

    return result;
  }

  /** True when the change was actually applied. Drives the honest verdict. */
  applied(): boolean {
    return this.fired;
  }
}
