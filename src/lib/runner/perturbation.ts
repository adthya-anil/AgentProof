import type { ManualClock } from "../core/clock.js";
import type { ToolCaller, ToolResult } from "../guard/guard.js";
import type { ToolName } from "../hamperhub/tools.js";

/**
 * Environment perturbations applied between the agent and the Guard (§7C).
 *
 * The other perturbations — moving a price, dropping stock, expiring a quote —
 * act on merchant state directly. These three act on the *transport*: latency,
 * duplicate delivery, and replay. They are what expose stateful payment failures
 * rather than malformed-input failures, because each one produces a sequence that
 * is individually valid at every step.
 *
 * The wrapper deliberately has no power to allow anything. It decides which calls
 * happen and in what order; every call still passes through the Guard and is
 * judged by the same invariants. A perturbation can therefore reveal a defect but
 * never manufacture one.
 */
export interface PerturbationPlan {
  /**
   * Latency before a tool executes.
   *
   * `advanceClockMinutes` moves the injected clock, which is what actually makes
   * a quote expire; `realMs` is a genuine pause for when wall-clock behaviour
   * matters. Real pauses are kept tiny so the suite stays fast.
   */
  delay?: {
    tool: ToolName;
    /** Nth matching call to delay, 1-indexed. Defaults to the first. */
    occurrence?: number;
    advanceClockMinutes?: number;
    realMs?: number;
  };

  /**
   * Deliver the same tool call twice.
   *
   * Models at-least-once delivery: a duplicated request the agent never intended
   * to repeat. The agent receives the first response, so from its point of view
   * nothing unusual happened — which is exactly why an integration without
   * idempotency quietly does the work twice.
   */
  duplicate?: {
    tool: ToolName;
    occurrence?: number;
  };

  /**
   * Re-issue an earlier recorded call verbatim, later in the journey.
   *
   * Models a replayed request. `after` names the tool whose call triggers the
   * replay; `replay` names the earlier tool whose arguments are re-sent. Tests
   * whether the merchant re-executes a stale operation — re-approving a quote,
   * or re-opening a checkout after one already exists.
   */
  replay?: {
    replay: ToolName;
    after: ToolName;
  };
}

export interface PerturbationEvent {
  kind: "delay" | "duplicate" | "replay";
  tool: ToolName;
  detail: string;
}

/**
 * Wraps a `ToolCaller` and applies a perturbation plan.
 *
 * Records what it did so a report can attribute a violation to the perturbation
 * that provoked it — a finding with no visible cause is not actionable.
 */
export class PerturbingToolCaller implements ToolCaller {
  private readonly counts = new Map<string, number>();
  private readonly seen: Array<{ name: ToolName; args: unknown }> = [];
  private readonly events: PerturbationEvent[] = [];

  constructor(
    private readonly inner: ToolCaller,
    private readonly plan: PerturbationPlan,
    private readonly clock?: ManualClock,
  ) {}

  applied(): readonly PerturbationEvent[] {
    return this.events;
  }

  async callTool(name: ToolName, rawArgs: unknown): Promise<ToolResult> {
    const occurrence = (this.counts.get(name) ?? 0) + 1;
    this.counts.set(name, occurrence);

    await this.maybeDelay(name, occurrence);

    const result = await this.inner.callTool(name, rawArgs);
    this.seen.push({ name, args: rawArgs });

    await this.maybeDuplicate(name, occurrence, rawArgs);
    await this.maybeReplay(name);

    // The agent always sees the result of *its own* call. Duplicates and replays
    // are invisible to it, which is the point: a well-behaved agent should not
    // have to defend against them.
    return result;
  }

  private async maybeDelay(name: ToolName, occurrence: number): Promise<void> {
    const delay = this.plan.delay;
    if (!delay || delay.tool !== name) return;
    if (occurrence !== (delay.occurrence ?? 1)) return;

    if (delay.advanceClockMinutes && this.clock) {
      this.clock.advanceMinutes(delay.advanceClockMinutes);
      this.events.push({
        kind: "delay",
        tool: name,
        detail: `advanced clock ${delay.advanceClockMinutes} minutes before ${name}`,
      });
    }
    if (delay.realMs) {
      await sleep(delay.realMs);
      this.events.push({
        kind: "delay",
        tool: name,
        detail: `paused ${delay.realMs}ms before ${name}`,
      });
    }
  }

  private async maybeDuplicate(
    name: ToolName,
    occurrence: number,
    rawArgs: unknown,
  ): Promise<void> {
    const duplicate = this.plan.duplicate;
    if (!duplicate || duplicate.tool !== name) return;
    if (occurrence !== (duplicate.occurrence ?? 1)) return;

    const second = await this.inner.callTool(name, rawArgs);
    this.events.push({
      kind: "duplicate",
      tool: name,
      detail:
        `delivered ${name} a second time; merchant ` +
        `${second.ok ? "accepted the duplicate" : "rejected the duplicate"}`,
    });
  }

  private async maybeReplay(name: ToolName): Promise<void> {
    const replay = this.plan.replay;
    if (!replay || replay.after !== name) return;

    // Only replay once, and only if the target call actually happened.
    if (this.events.some((e) => e.kind === "replay")) return;
    const earlier = this.seen.find((entry) => entry.name === replay.replay);
    if (!earlier) return;

    const result = await this.inner.callTool(earlier.name, earlier.args);
    this.events.push({
      kind: "replay",
      tool: earlier.name,
      detail:
        `replayed the earlier ${earlier.name} call after ${name}; merchant ` +
        `${result.ok ? "accepted the replay" : "rejected the replay"}`,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
