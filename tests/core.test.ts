import { describe, expect, it } from "vitest";
import { allocateDiscount } from "../src/lib/core/allocation.js";
import { AuditLog } from "../src/lib/audit/log.js";
import { ManualClock } from "../src/lib/core/clock.js";
import { IdFactory, stableHash } from "../src/lib/core/ids.js";
import {
  effectiveDiscountPercent,
  formatMinor,
  percentOf,
  roundPercent,
  rupees,
} from "../src/lib/core/money.js";
import { computePricing } from "../src/lib/hamperhub/pricing.js";
import { MutationSet } from "../src/lib/hamperhub/mutations.js";
import { loadPolicyFromYaml } from "../src/lib/policy/load.js";
import { POLICY_YAML } from "./helpers.js";

describe("money", () => {
  it("keeps rupees as integer paise", () => {
    expect(rupees(1399)).toBe(139900);
    expect(rupees(1399.5)).toBe(139950);
  });

  it("formats Indian digit grouping with two decimals", () => {
    expect(formatMinor(139900)).toBe("₹1,399.00");
    expect(formatMinor(132014)).toBe("₹1,320.14");
    expect(formatMinor(-4700)).toBe("-₹47.00");
    expect(formatMinor(rupees(1234567))).toBe("₹12,34,567.00");
  });

  it("computes the effective discount from the endpoints", () => {
    // 4% then 4.9% applied sequentially is 8.7%, not 8.9%.
    const subtotal = rupees(1446);
    const afterFirst = subtotal - percentOf(subtotal, 4);
    const afterSecond = afterFirst - percentOf(afterFirst, 4.9);
    expect(roundPercent(effectiveDiscountPercent(subtotal, afterSecond))).toBe(8.7);
  });

  it("reports the same 8.7% regardless of subtotal", () => {
    for (const major of [500, 1446, 1695, 4999]) {
      const subtotal = rupees(major);
      const a = subtotal - percentOf(subtotal, 4);
      const b = a - percentOf(a, 4.9);
      expect(roundPercent(effectiveDiscountPercent(subtotal, b))).toBeCloseTo(8.7, 1);
    }
  });
});

describe("allocateDiscount", () => {
  it("allocates parts that sum to exactly the whole", () => {
    const lines = [59900, 34900, 39900, 9900];
    const allocations = allocateDiscount(lines, 4700);
    expect(allocations.reduce((s, v) => s + v, 0)).toBe(4700);
  });

  it("handles awkward remainders exactly", () => {
    const lines = [333, 333, 334];
    const allocations = allocateDiscount(lines, 100);
    expect(allocations.reduce((s, v) => s + v, 0)).toBe(100);
  });

  it("returns zeros when there is nothing to allocate", () => {
    expect(allocateDiscount([100, 200], 0)).toEqual([0, 0]);
    expect(allocateDiscount([0, 0], 50)).toEqual([0, 0]);
  });
});

describe("pricing engine", () => {
  const policy = loadPolicyFromYaml(POLICY_YAML);
  const lines = [
    {
      productId: "a",
      quantity: 1,
      unitPriceMinor: rupees(599),
      lineTotalMinor: rupees(599),
      minPriceMinor: rupees(400),
    },
    {
      productId: "b",
      quantity: 1,
      unitPriceMinor: rupees(349),
      lineTotalMinor: rupees(349),
      minPriceMinor: rupees(250),
    },
    {
      productId: "c",
      quantity: 1,
      unitPriceMinor: rupees(399),
      lineTotalMinor: rupees(399),
      minPriceMinor: rupees(300),
    },
    {
      productId: "d",
      quantity: 1,
      unitPriceMinor: rupees(99),
      lineTotalMinor: rupees(99),
      minPriceMinor: rupees(70),
    },
  ];
  const config = {
    maxDiscountPercent: policy.pricing.maximumDiscountPercent,
    allowStacking: policy.pricing.allowDiscountStacking,
  };

  it("produces exactly ₹1,399 for the demo hamper", () => {
    const result = computePricing(
      lines,
      ["HAMPERCREDIT"],
      config,
      MutationSet.fixed(),
    );
    expect(result.subtotalMinor).toBe(rupees(1446));
    expect(result.totalMinor).toBe(rupees(1399));
    expect(roundPercent(result.effectivePercent)).toBe(3.25);
  });

  it("stacks to 8.7% when the defect is active", () => {
    const result = computePricing(
      lines,
      ["HAMPER4", "LOYAL49"],
      config,
      MutationSet.only("discount_stacking"),
    );
    expect(result.discounts).toHaveLength(2);
    expect(roundPercent(result.effectivePercent)).toBe(8.7);
    expect(result.totalMinor).toBe(rupees(1320.14));
  });

  it("refuses the second discount once fixed", () => {
    const result = computePricing(
      lines,
      ["HAMPER4", "LOYAL49"],
      config,
      MutationSet.fixed(),
    );
    expect(result.discounts).toHaveLength(1);
    expect(result.rejectedPromos.map((r) => r.code)).toContain("LOYAL49");
    expect(result.effectivePercent).toBeLessThanOrEqual(5);
  });

  it("rejects a single promo that alone breaches the cap", () => {
    const result = computePricing(
      lines,
      ["FESTIVE10"],
      config,
      MutationSet.fixed(),
    );
    expect(result.discounts).toHaveLength(0);
    expect(result.totalMinor).toBe(rupees(1446));
  });

  it("rejects unknown and ineligible promo codes", () => {
    const result = computePricing(
      lines.slice(0, 2),
      ["NOPE", "HAMPER4"],
      config,
      MutationSet.fixed(),
    );
    const codes = result.rejectedPromos.map((r) => r.code);
    expect(codes).toContain("NOPE");
    // HAMPER4 needs four items; this bundle has two.
    expect(codes).toContain("HAMPER4");
  });
});

describe("audit log", () => {
  it("chains hashes and verifies", () => {
    const clock = new ManualClock();
    const log = new AuditLog(clock);
    log.append({ type: "run.started", runId: "r1" });
    clock.advanceMs(1000);
    log.append({ type: "intent.received", runId: "r1", intentId: "i1" });
    log.append({ type: "quote.created", runId: "r1", intentId: "i1" });

    expect(log.all()).toHaveLength(3);
    expect(log.verify()).toEqual({ ok: true, brokenAtSeq: null });
    expect(log.all()[1]?.prevHash).toBe(log.all()[0]?.hash);
  });

  it("detects tampering with a historical event", () => {
    const log = new AuditLog(new ManualClock());
    log.append({ type: "run.started", runId: "r1" });
    log.append({ type: "quote.created", runId: "r1", reason: "original" });
    log.append({ type: "checkout.requested", runId: "r1" });

    // Rewrite history the way a bad actor would.
    (log.all()[1] as { reason: string | null }).reason = "edited after the fact";

    const result = log.verify();
    expect(result.ok).toBe(false);
    expect(result.brokenAtSeq).toBe(2);
  });

  it("redacts credentials that leak into tool payloads", () => {
    const log = new AuditLog(new ManualClock());
    const event = log.append({
      type: "tool.executed",
      runId: "r1",
      input: { key_secret: "supersecret", amount: 100, nested: { token: "abc" } },
    });
    const input = event.input as Record<string, unknown>;
    expect(input.key_secret).toBe("[redacted]");
    expect((input.nested as Record<string, unknown>).token).toBe("[redacted]");
    expect(input.amount).toBe(100);
    expect(JSON.stringify(event)).not.toContain("supersecret");
  });

  it("scopes events by run and intent", () => {
    const log = new AuditLog(new ManualClock());
    log.append({ type: "intent.received", runId: "r1", intentId: "i1" });
    log.append({ type: "intent.received", runId: "r1", intentId: "i2" });
    log.append({ type: "intent.received", runId: "r2", intentId: "i3" });
    expect(log.forRun("r1")).toHaveLength(2);
    expect(log.forIntent("i2")).toHaveLength(1);
  });
});

describe("determinism", () => {
  it("produces identical ids for identical seeds", () => {
    const a = new IdFactory("seed");
    const b = new IdFactory("seed");
    expect([a.next("q"), a.next("q")]).toEqual([b.next("q"), b.next("q")]);
  });

  it("hashes independently of key order", () => {
    expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
  });
});

describe("policy loading", () => {
  it("normalises rupee amounts to paise", () => {
    const policy = loadPolicyFromYaml(POLICY_YAML);
    expect(policy.transaction.maximumAmountMinor).toBe(rupees(5000));
  });

  it("rejects an invalid policy with a useful message", () => {
    expect(() =>
      loadPolicyFromYaml(POLICY_YAML.replace("maximum_amount: 5000", "maximum_amount: -1")),
    ).toThrow(/maximum_amount/);
  });

  it("rejects unknown policy keys rather than ignoring them", () => {
    expect(() => loadPolicyFromYaml(`${POLICY_YAML}\nsurprise: true\n`)).toThrow(
      /Invalid merchant policy/,
    );
  });
});
