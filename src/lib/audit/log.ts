import { createHash } from "node:crypto";
import type { Clock } from "../core/clock.js";
import { canonicalize } from "../core/ids.js";
import {
  type AuditEvent,
  type AuditEventInput,
  sanitize,
} from "./events.js";

export const GENESIS_HASH = "0".repeat(64);

/**
 * Append-only audit log with a tamper-evident hash chain.
 *
 * Each event's hash covers its own canonical content plus the previous hash, so
 * altering or deleting any historical event invalidates every hash after it.
 * `verify()` is what lets us claim the replay a judge sees is the run that
 * actually happened.
 */
export class AuditLog {
  private events: AuditEvent[] = [];
  private lastHash = GENESIS_HASH;
  private subscribers = new Set<(event: AuditEvent) => void>();

  constructor(private readonly clock: Clock) {}

  /**
   * Observe events as they are appended.
   *
   * Everything meaningful already flows through this log — tool calls, policy
   * verdicts, blocks, orders — so subscribing here streams the whole journey
   * without threading callbacks through the agent and the Guard. Returns an
   * unsubscribe function.
   *
   * Subscriber errors are swallowed: a broken listener (a disconnected browser,
   * say) must never corrupt the append-only log it is watching.
   */
  subscribe(listener: (event: AuditEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  append(input: AuditEventInput): AuditEvent {
    const seq = this.events.length + 1;
    const at = this.clock.now();

    const body = {
      seq,
      at: at.toISOString(),
      type: input.type,
      runId: input.runId,
      intentId: input.intentId ?? null,
      toolName: input.toolName ?? null,
      input: sanitize(input.input),
      output: sanitize(input.output),
      policyVersion: input.policyVersion ?? null,
      decision: input.decision ?? null,
      reason: input.reason ?? null,
      quoteId: input.quoteId ?? null,
      providerOrderId: input.providerOrderId ?? null,
      violationIds: input.violationIds ?? [],
    };

    const hash = createHash("sha256")
      .update(this.lastHash)
      .update(canonicalize(body))
      .digest("hex");

    const event: AuditEvent = {
      ...body,
      at,
      prevHash: this.lastHash,
      hash,
    };

    this.events.push(event);
    this.lastHash = hash;

    for (const listener of this.subscribers) {
      try {
        listener(event);
      } catch {
        // A failing observer must not break the log.
      }
    }
    return event;
  }

  all(): readonly AuditEvent[] {
    return this.events;
  }

  forRun(runId: string): AuditEvent[] {
    return this.events.filter((event) => event.runId === runId);
  }

  forIntent(intentId: string): AuditEvent[] {
    return this.events.filter((event) => event.intentId === intentId);
  }

  head(): string {
    return this.lastHash;
  }

  /** Recomputes the whole chain. Returns the first broken sequence number. */
  verify(): { ok: boolean; brokenAtSeq: number | null } {
    let prev = GENESIS_HASH;
    for (const event of this.events) {
      const { prevHash, hash, at, ...rest } = event;
      const body = { ...rest, at: at.toISOString() };
      const expected = createHash("sha256")
        .update(prev)
        .update(canonicalize(body))
        .digest("hex");
      if (prevHash !== prev || expected !== hash) {
        return { ok: false, brokenAtSeq: event.seq };
      }
      prev = hash;
    }
    return { ok: true, brokenAtSeq: null };
  }

  toJSONL(): string {
    return this.events
      .map((event) => JSON.stringify({ ...event, at: event.at.toISOString() }))
      .join("\n");
  }
}
