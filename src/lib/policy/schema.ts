import { z } from "zod";
import { type Minor, rupees } from "../core/money.js";

/**
 * The merchant policy is the single source of truth for the Guard.
 *
 * An LLM may *draft* this document from a natural-language description, but the
 * developer approves the structured version and only the structured version is
 * enforced. Nothing downstream reads the original prompt.
 *
 * Amounts are authored in major units (rupees) because humans edit this file;
 * they are normalised to minor units at load so no float rupees ever reach the
 * invariants.
 */
export const policyFileSchema = z
  .object({
    policy_id: z.string().min(1),
    currency: z.literal("INR"),
    transaction: z.object({
      maximum_amount: z.number().positive(),
      quote_expiry_minutes: z.number().int().positive(),
      require_buyer_confirmation: z.boolean(),
      one_payment_per_intent: z.boolean(),
    }),
    pricing: z.object({
      maximum_discount_percent: z.number().min(0).max(100),
      allow_discount_stacking: z.boolean(),
      payment_must_equal_approved_quote: z.boolean(),
      enforce_floor_price: z.boolean().default(true),
    }),
    inventory: z.object({
      require_current_availability: z.boolean(),
      reserve_before_checkout: z.boolean(),
      reservation_minutes: z.number().int().positive(),
    }),
    products: z.object({
      bundles_allowed: z.boolean(),
      unknown_allergen_status: z.enum(["escalate", "block", "allow"]),
      substitutions_require_approval: z.boolean(),
    }),
  })
  .strict();

export type PolicyFile = z.infer<typeof policyFileSchema>;

export interface Policy {
  policyId: string;
  currency: "INR";
  transaction: {
    maximumAmountMinor: Minor;
    quoteExpiryMinutes: number;
    requireBuyerConfirmation: boolean;
    onePaymentPerIntent: boolean;
  };
  pricing: {
    maximumDiscountPercent: number;
    allowDiscountStacking: boolean;
    paymentMustEqualApprovedQuote: boolean;
    enforceFloorPrice: boolean;
  };
  inventory: {
    requireCurrentAvailability: boolean;
    reserveBeforeCheckout: boolean;
    reservationMinutes: number;
  };
  products: {
    bundlesAllowed: boolean;
    unknownAllergenStatus: "escalate" | "block" | "allow";
    substitutionsRequireApproval: boolean;
  };
  /** Raw document retained so reports can show exactly what was enforced. */
  source: PolicyFile;
}

export function normalizePolicy(file: PolicyFile): Policy {
  return {
    policyId: file.policy_id,
    currency: file.currency,
    transaction: {
      maximumAmountMinor: rupees(file.transaction.maximum_amount),
      quoteExpiryMinutes: file.transaction.quote_expiry_minutes,
      requireBuyerConfirmation: file.transaction.require_buyer_confirmation,
      onePaymentPerIntent: file.transaction.one_payment_per_intent,
    },
    pricing: {
      maximumDiscountPercent: file.pricing.maximum_discount_percent,
      allowDiscountStacking: file.pricing.allow_discount_stacking,
      paymentMustEqualApprovedQuote: file.pricing.payment_must_equal_approved_quote,
      enforceFloorPrice: file.pricing.enforce_floor_price,
    },
    inventory: {
      requireCurrentAvailability: file.inventory.require_current_availability,
      reserveBeforeCheckout: file.inventory.reserve_before_checkout,
      reservationMinutes: file.inventory.reservation_minutes,
    },
    products: {
      bundlesAllowed: file.products.bundles_allowed,
      unknownAllergenStatus: file.products.unknown_allergen_status,
      substitutionsRequireApproval: file.products.substitutions_require_approval,
    },
    source: file,
  };
}

export function parsePolicy(raw: unknown): Policy {
  const result = policyFileSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid merchant policy: ${issues}`);
  }
  return normalizePolicy(result.data);
}
