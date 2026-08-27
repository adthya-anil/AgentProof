/**
 * The four seeded defects (§8), each run twice: once against the vulnerable
 * integration and once against the fixed one.
 *
 * This is the core honesty check. For every defect we require:
 *   - vulnerable integration  → AgentProof flags it, and no money escapes;
 *   - fixed integration       → no findings, and the journey completes or is
 *                               safely rejected.
 *
 * A defect that only "fails" because the fixed run also fails would be a
 * worthless test, so both directions are asserted.
 */
import { toMajor } from "../lib/core/money.js";
import { createEnvironment, createIntent } from "../lib/harness.js";
import { type Environment } from "../lib/harness.js";
import { type MutationId, MutationSet, describeMutation } from "../lib/hamperhub/mutations.js";
import type { ToolResult } from "../lib/guard/guard.js";
import type { Violation } from "../lib/policy/violations.js";

interface JourneyOutcome {
  findings: Violation[];
  providerOrders: number;
  note: string;
  /**
   * True when the merchant's own code refused the operation.
   *
   * This matters for scoring. Some perturbations — a genuine mid-flight price
   * change — are legitimate blocking conditions, so a *fixed* integration is
   * supposed to reject them and the Guard is supposed to agree. Counting the
   * Guard's concurring verdict as a false positive would be wrong; what must be
   * true of a fixed integration is that no unsafe money movement occurs and that
   * it caught the condition itself.
   */
  rejectedByIntegration: boolean;
}

const HAMPER = [
  { product_id: "p-coffee-arabica", quantity: 1 },
  { product_id: "p-choc-dark-vegan", quantity: 1 },
  { product_id: "p-mug-ceramic", quantity: 1 },
  { product_id: "p-card-handmade", quantity: 1 },
];

/** Defect 1: two sub-cap discounts stack to 8.7%. */
async function discountStackingJourney(env: Environment): Promise<JourneyOutcome> {
  const { guard, ids, clock } = env;
  const intent = createIntent(ids, clock, {
    runId: "run_defect_discount",
    utterance:
      "Build a coffee hamper for a birthday and apply every discount I qualify for.",
    maxBudget: 1500,
  });
  guard.beginIntent(intent);

  const bundle = await guard.callTool("create_bundle", {
    items: HAMPER,
    promo_codes: ["HAMPER4", "LOYAL49"],
  });
  if (!bundle.ok) return outcome(env, guard, `bundle rejected: ${bundle.reason}`);

  const quoted = await guard.callTool("create_quote", {
    bundle_id: (bundle.data as { bundle_id: string }).bundle_id,
  });
  const note = quoted.ok
    ? `quote allowed at ₹${(quoted.data as { total: number }).total}`
    : `quote blocked: ${quoted.reason.slice(0, 80)}`;
  return outcome(env, guard, note, quoted);
}

/** Defect 2: price changes after approval; stale quote reused. */
async function staleQuoteJourney(env: Environment): Promise<JourneyOutcome> {
  const { guard, ids, clock } = env;
  const intent = createIntent(ids, clock, {
    runId: "run_defect_stale",
    utterance: "A coffee gift hamper under ₹1,500 please.",
    maxBudget: 1500,
  });
  guard.beginIntent(intent);

  const bundle = await guard.callTool("create_bundle", {
    items: HAMPER,
    promo_codes: ["HAMPERCREDIT"],
  });
  if (!bundle.ok) return outcome(env, guard, `bundle rejected: ${bundle.reason}`);
  const quoted = await guard.callTool("create_quote", {
    bundle_id: (bundle.data as { bundle_id: string }).bundle_id,
  });
  if (!quoted.ok) return outcome(env, guard, `quote blocked: ${quoted.reason}`);
  const quote = quoted.data as { quote_id: string; total: number };

  const approved = await guard.callTool("approve_quote", {
    quote_id: quote.quote_id,
    approved_amount: quote.total,
    confirmation_text: `Yes, charge ₹${quote.total}.`,
  });
  if (!approved.ok) return outcome(env, guard, `approval blocked: ${approved.reason}`);

  // The merchant raises the coffee price after the buyer has agreed.
  env.state.setPrice("p-coffee-arabica", 64900, "Supplier cost increase");
  clock.advanceMinutes(1);

  const checkout = await guard.callTool("create_checkout", {
    quote_id: quote.quote_id,
    approval_receipt_id: (approved.data as { approval_receipt_id: string })
      .approval_receipt_id,
  });
  return outcome(
    env,
    guard,
    checkout.ok
      ? `checkout ALLOWED at ₹${(checkout.data as { amount: number }).amount}`
      : `checkout blocked: ${checkout.reason.slice(0, 80)}`,
    checkout,
  );
}

/** Defect 3: retry after a timeout opens a second payable order. */
async function duplicateOrderJourney(env: Environment): Promise<JourneyOutcome> {
  const { guard, ids, clock, fake } = env;
  fake?.setFaults({ timeoutOnCreateOrderAttempt: 1 });

  const intent = createIntent(ids, clock, {
    runId: "run_defect_duplicate",
    utterance: "Order the coffee hamper, and retry if the payment call fails.",
    maxBudget: 1500,
  });
  guard.beginIntent(intent);

  const bundle = await guard.callTool("create_bundle", {
    items: HAMPER,
    promo_codes: ["HAMPERCREDIT"],
  });
  if (!bundle.ok) return outcome(env, guard, `bundle rejected: ${bundle.reason}`);
  const quoted = await guard.callTool("create_quote", {
    bundle_id: (bundle.data as { bundle_id: string }).bundle_id,
  });
  if (!quoted.ok) return outcome(env, guard, `quote blocked: ${quoted.reason}`);
  const quote = quoted.data as { quote_id: string; total: number };

  const approved = await guard.callTool("approve_quote", {
    quote_id: quote.quote_id,
    approved_amount: quote.total,
    confirmation_text: `Yes, charge ₹${quote.total}.`,
  });
  if (!approved.ok) return outcome(env, guard, `approval blocked: ${approved.reason}`);
  const receiptId = (approved.data as { approval_receipt_id: string })
    .approval_receipt_id;

  // First attempt times out. From the agent's perspective nothing happened.
  const first = await guard.callTool("create_checkout", {
    quote_id: quote.quote_id,
    approval_receipt_id: receiptId,
  });

  // The agent does what agents do: it retries.
  const second = await guard.callTool("create_checkout", {
    quote_id: quote.quote_id,
    approval_receipt_id: receiptId,
  });

  return outcome(
    env,
    guard,
    `first=${first.ok ? "ok" : "failed"}, retry=${
      second.ok ? "ALLOWED (duplicate!)" : "blocked"
    }`,
    second,
  );
}

/** Defect 4: unknown allergen data treated as allergen-free. */
async function unknownAllergenJourney(env: Environment): Promise<JourneyOutcome> {
  const { guard, ids, clock } = env;
  const intent = createIntent(ids, clock, {
    runId: "run_defect_allergen",
    utterance:
      "A chocolate gift box under ₹1,500. I have a serious peanut allergy.",
    maxBudget: 1500,
    mustAvoidAllergens: ["peanut"],
  });
  guard.beginIntent(intent);

  // The agent filters correctly; the question is what the catalog hands back.
  const search = await guard.callTool("search_products", {
    category: "chocolate",
    exclude_allergens: ["peanut"],
  });
  if (!search.ok) return outcome(env, guard, `search failed: ${search.reason}`);
  const results = search.data as Array<{ product_id: string }>;
  const truffleOffered = results.some((p) => p.product_id === "p-choc-truffle");

  if (!truffleOffered) {
    return outcome(
      env,
      guard,
      "catalog correctly withheld the unknown-allergen product",
    );
  }

  // The agent trusts the filtered results and bundles the unknown product.
  const bundle = await guard.callTool("create_bundle", {
    items: [
      { product_id: "p-choc-truffle", quantity: 1 },
      { product_id: "p-card-handmade", quantity: 1 },
    ],
  });
  if (!bundle.ok) return outcome(env, guard, `bundle rejected: ${bundle.reason}`);

  const quoted = await guard.callTool("create_quote", {
    bundle_id: (bundle.data as { bundle_id: string }).bundle_id,
  });
  return outcome(
    env,
    guard,
    quoted.ok
      ? "quote ALLOWED containing unknown-allergen product"
      : `quote stopped: ${quoted.reason.slice(0, 80)}`,
    quoted,
  );
}

function outcome(
  env: Environment,
  guard: Environment["guard"],
  note: string,
  lastResult?: ToolResult,
): JourneyOutcome {
  return {
    findings: [...guard.recordedViolations(), ...guard.recordedEscalations()],
    providerOrders: env.fake?.allOrders().length ?? 0,
    note,
    rejectedByIntegration:
      lastResult !== undefined &&
      !lastResult.ok &&
      lastResult.decision === "rejected",
  };
}

const DEFECTS: Array<{
  mutation: MutationId;
  label: string;
  journey: (env: Environment) => Promise<JourneyOutcome>;
}> = [
  {
    mutation: "discount_stacking",
    label: "Defect 1 — discount stacking",
    journey: discountStackingJourney,
  },
  {
    mutation: "missing_price_version_check",
    label: "Defect 2 — stale quote after price change",
    journey: staleQuoteJourney,
  },
  {
    mutation: "missing_idempotency",
    label: "Defect 3 — duplicate order on retry",
    journey: duplicateOrderJourney,
  },
  {
    mutation: "unknown_allergen_safe",
    label: "Defect 4 — unknown allergen data treated as safe",
    journey: unknownAllergenJourney,
  },
];

async function main(): Promise<void> {
  console.log("AgentProof — seeded defect detection\n");
  let failures = 0;

  for (const defect of DEFECTS) {
    const descriptor = describeMutation(defect.mutation);
    console.log(`${defect.label}`);
    console.log(`  ${descriptor.description}`);
    console.log(`  Expected invariant: ${descriptor.expectedInvariant}`);

    // --- vulnerable integration ---
    const vulnEnv = createEnvironment({
      mutations: MutationSet.only(defect.mutation),
    });
    const vuln = await defect.journey(vulnEnv);
    const fired = vuln.findings.some(
      (f) => f.invariantId === descriptor.expectedInvariant,
    );
    const atRisk = vuln.findings.reduce((s, f) => s + f.moneyAtRiskMinor, 0);

    console.log(`\n  VULNERABLE: ${vuln.note}`);
    for (const finding of vuln.findings) {
      console.log(`    • [${finding.invariantId}] ${finding.message}`);
    }
    console.log(
      `    detected=${fired ? "YES" : "NO"} | money at risk ₹${toMajor(atRisk)} | ` +
        `provider orders ${vuln.providerOrders}`,
    );

    // --- fixed integration ---
    const fixedEnv = createEnvironment({ mutations: MutationSet.fixed() });
    const fixed = await defect.journey(fixedEnv);
    console.log(`\n  FIXED: ${fixed.note}`);
    for (const finding of fixed.findings) {
      console.log(`    • [${finding.invariantId}] ${finding.message}`);
    }
    console.log(
      `    findings=${fixed.findings.length} | provider orders ${fixed.providerOrders}` +
        ` | self-rejected=${fixed.rejectedByIntegration}`,
    );

    if (!fired) {
      console.log(`\n  ✗ FAIL: ${descriptor.expectedInvariant} did not fire\n`);
      failures += 1;
    } else if (fixed.findings.length > 0 && !fixed.rejectedByIntegration) {
      console.log(
        `\n  ✗ FAIL: fixed integration produced findings without self-rejecting\n`,
      );
      failures += 1;
    } else if (vuln.providerOrders > 1) {
      console.log(
        `\n  ✗ FAIL: ${vuln.providerOrders} payable orders escaped the Guard\n`,
      );
      failures += 1;
    } else {
      const fixedNote = fixed.rejectedByIntegration
        ? "safely self-rejected on fixed"
        : "clean on fixed";
      console.log(`\n  ✓ detected on vulnerable, ${fixedNote}\n`);
    }
    console.log("─".repeat(78));
  }

  const detected = DEFECTS.length - failures;
  console.log(
    `\nDefect detection recall: ${detected}/${DEFECTS.length} ` +
      `(${Math.round((detected / DEFECTS.length) * 100)}%)`,
  );

  if (failures > 0) {
    console.error(`\n✗ ${failures} defect(s) not handled correctly`);
    process.exit(1);
  }
  console.log("\n✓ All seeded defects detected, with zero money-critical escapes.");
}

main().catch((error) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
