/**
 * Time is injected everywhere so that quote-expiry behaviour is a test input
 * rather than a race condition. Preflight runs advance a `ManualClock` to
 * expire quotes instantly; the runtime Guard uses `systemClock`.
 */
export interface Clock {
  now(): Date;
  nowMs(): number;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowMs: () => Date.now(),
};

export class ManualClock implements Clock {
  private current: number;

  constructor(start: Date | number = new Date("2026-03-01T10:00:00.000Z")) {
    this.current = typeof start === "number" ? start : start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  nowMs(): number {
    return this.current;
  }

  advanceMs(ms: number): void {
    this.current += ms;
  }

  advanceMinutes(minutes: number): void {
    this.advanceMs(minutes * 60_000);
  }

  set(at: Date | number): void {
    this.current = typeof at === "number" ? at : at.getTime();
  }
}

export function minutesFrom(clock: Clock, minutes: number): Date {
  return new Date(clock.nowMs() + minutes * 60_000);
}

export function isExpired(clock: Clock, expiresAt: Date): boolean {
  return clock.nowMs() > expiresAt.getTime();
}
