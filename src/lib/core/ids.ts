import { createHash, randomUUID } from "node:crypto";

/**
 * Seeded ID generation. Demo runs must be byte-identical between rehearsal and
 * the live judging slot, so every identifier comes from a seeded counter
 * instead of `randomUUID` unless the caller explicitly opts into randomness.
 */
export class IdFactory {
  private counters = new Map<string, number>();

  constructor(private readonly seed: string = "agentproof") {}

  next(prefix: string): string {
    const count = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, count);
    const digest = createHash("sha256")
      .update(`${this.seed}:${prefix}:${count}`)
      .digest("hex")
      .slice(0, 10);
    return `${prefix}_${digest}`;
  }

  reset(): void {
    this.counters.clear();
  }
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/**
 * Stable hash of a value, used for idempotency keys and the audit hash chain.
 * Object keys are sorted so that logically identical payloads hash equally
 * regardless of construction order.
 */
export function stableHash(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "null";
    return Number.isInteger(value) ? String(value) : value.toFixed(10);
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
      .join(",")}}`;
  }
  return "null";
}
