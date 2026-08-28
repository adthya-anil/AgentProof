import { AuditLog } from "./audit/log.js";
import { type Clock, ManualClock } from "./core/clock.js";
import { IdFactory } from "./core/ids.js";
import { type Minor, rupees } from "./core/money.js";
import type { BuyerIntent } from "./core/types.js";
import { Guard } from "./guard/guard.js";
import { MutationSet } from "./hamperhub/mutations.js";
import { HamperHubService } from "./hamperhub/service.js";
import { MerchantState } from "./hamperhub/state.js";
import { FakePaymentProvider } from "./payments/fake.js";
import type { PaymentProvider } from "./payments/provider.js";
import { RazorpayProvider } from "./payments/razorpay.js";
import { PolicyEngine } from "./policy/engine.js";
import { loadPolicyFromFile, policyVersion } from "./policy/load.js";
import type { Policy } from "./policy/schema.js";

export interface Environment {
  clock: ManualClock;
  ids: IdFactory;
  state: MerchantState;
  policy: Policy;
  policyVersion: string;
  engine: PolicyEngine;
  service: HamperHubService;
  guard: Guard;
  audit: AuditLog;
  payments: PaymentProvider;
  fake: FakePaymentProvider | null;
  mutations: MutationSet;
}

export interface EnvironmentOptions {
  mutations?: MutationSet;
  policy?: Policy;
  seed?: string;
  startAt?: Date;
  clock?: ManualClock;
  /** Pass a real provider to run against Razorpay test mode. */
  paymentProvider?: PaymentProvider;
  mode?: "preflight" | "runtime";
}

/**
 * Wires a complete, isolated AgentProof environment.
 *
 * Each preflight journey gets its own environment so that a state perturbation
 * in one scenario cannot leak into another — flaky cross-talk between journeys
 * would make the detection numbers meaningless.
 */
export function createEnvironment(opts: EnvironmentOptions = {}): Environment {
  const clock = opts.clock ?? new ManualClock(opts.startAt);
  /**
   * Explicit seed, then `AGENTPROOF_SEED`, then a fixed default.
   *
   * The environment variable is read here because it was documented in both the
   * README and `.env.example` as controlling reproducible runs while being read by
   * absolutely nothing — every run used the hard-coded default no matter what the
   * file said. A knob that does nothing is worse than no knob, particularly in a
   * project whose entire claim is that its reports mean what they say.
   */
  const envSeed = process.env.AGENTPROOF_SEED?.trim();
  const ids = new IdFactory(opts.seed ?? (envSeed || "agentproof"));
  const state = new MerchantState(clock, ids);
  const policy = opts.policy ?? loadPolicyFromFile();
  const version = policyVersion(policy);
  const mutations = opts.mutations ?? MutationSet.fixed();
  const audit = new AuditLog(clock);
  const engine = new PolicyEngine();

  const fake =
    opts.paymentProvider === undefined
      ? new FakePaymentProvider(ids, clock)
      : null;
  const payments = opts.paymentProvider ?? fake!;

  const service = new HamperHubService({
    clock,
    ids,
    state,
    policy,
    policyVersion: version,
    mutations,
    payments,
  });

  const guard = new Guard({
    clock,
    policy,
    policyVersion: version,
    engine,
    service,
    state,
    audit,
    mode: opts.mode ?? "preflight",
    paymentProvider: { name: payments.name, isReal: payments.isReal },
  });

  return {
    clock,
    ids,
    state,
    policy,
    policyVersion: version,
    engine,
    service,
    guard,
    audit,
    payments,
    fake,
    mutations,
  };
}

/** Builds a Razorpay test-mode provider from the environment, if configured. */
export function razorpayFromEnv(): RazorpayProvider | null {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) return null;
  return new RazorpayProvider({ keyId, keySecret });
}

export interface IntentOptions {
  runId: string;
  utterance: string;
  maxBudget?: number;
  requireVegan?: boolean;
  mustAvoidAllergens?: string[];
  occasion?: string | null;
  themes?: string[];
}

export function createIntent(
  ids: IdFactory,
  clock: Clock,
  opts: IntentOptions,
): BuyerIntent {
  const maxBudgetMinor: Minor | null =
    opts.maxBudget === undefined ? null : rupees(opts.maxBudget);
  return {
    id: ids.next("intent"),
    runId: opts.runId,
    utterance: opts.utterance,
    constraints: {
      maxBudgetMinor,
      requireVegan: opts.requireVegan ?? false,
      mustAvoidAllergens: opts.mustAvoidAllergens ?? [],
      occasion: opts.occasion ?? null,
      themes: opts.themes ?? [],
    },
    createdAt: clock.now(),
  };
}
