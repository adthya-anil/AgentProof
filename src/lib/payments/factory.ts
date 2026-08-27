import type { Clock } from "../core/clock.js";
import type { IdFactory } from "../core/ids.js";
import { FakePaymentProvider } from "./fake.js";
import { type PaymentProvider, PaymentProviderError } from "./provider.js";
import { RazorpayProvider } from "./razorpay.js";

export type PaymentAdapterKind = "fake" | "razorpay";

export type PaymentAdapterSelection =
  | {
      available: true;
      kind: PaymentAdapterKind;
      provider: PaymentProvider;
      /** Present only for the real adapter, for display. Never the secret. */
      keyId: string | null;
    }
  | {
      available: false;
      kind: PaymentAdapterKind;
      /** Why the requested adapter could not be constructed. */
      reason: string;
      /** What the operator should do about it. */
      remediation: string;
    };

/**
 * Chooses a payment provider from the environment.
 *
 * Returns a result rather than throwing, because "Razorpay is not configured" is
 * a normal state for this project — the whole suite runs offline by default and
 * the real adapter is opt-in. Callers can then explain the situation instead of
 * dying with a stack trace.
 */
export function selectPaymentAdapter(deps: {
  ids: IdFactory;
  clock: Clock;
}): PaymentAdapterSelection {
  const requested = (
    process.env.PAYMENT_ADAPTER ?? "fake"
  ).toLowerCase() as PaymentAdapterKind;

  if (requested === "fake") {
    return {
      available: true,
      kind: "fake",
      provider: new FakePaymentProvider(deps.ids, deps.clock),
      keyId: null,
    };
  }

  if (requested !== "razorpay") {
    return {
      available: false,
      kind: "fake",
      reason: `Unknown PAYMENT_ADAPTER "${requested}"`,
      remediation: 'Set PAYMENT_ADAPTER to "fake" or "razorpay".',
    };
  }

  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    return {
      available: false,
      kind: "razorpay",
      reason: "RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are not both set",
      remediation:
        "Copy .env.example to .env and add your Razorpay **test mode** keys " +
        "from the dashboard (Settings → API Keys). Test keys start with " +
        '"rzp_test_".',
    };
  }

  try {
    return {
      available: true,
      kind: "razorpay",
      provider: new RazorpayProvider({ keyId, keySecret }),
      keyId,
    };
  } catch (error) {
    // The adapter refuses live credentials by design; surface that clearly.
    return {
      available: false,
      kind: "razorpay",
      reason:
        error instanceof PaymentProviderError
          ? error.message
          : String(error instanceof Error ? error.message : error),
      remediation:
        "AgentProof deliberately attempts unsafe transactions, so it only " +
        'accepts keys beginning with "rzp_test_".',
    };
  }
}

export function describeAdapter(selection: PaymentAdapterSelection): string {
  if (!selection.available) {
    return `${selection.kind} (unavailable: ${selection.reason})`;
  }
  return selection.kind === "razorpay"
    ? `razorpay test mode (${selection.keyId})`
    : "fake (deterministic, offline)";
}
