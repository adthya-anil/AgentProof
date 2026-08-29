import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { AuditEvent } from "../audit/events.js";
import { HAMPERHUB, type Merchant } from "../core/entities.js";
import { SEED_CATALOG, SEED_INVENTORY } from "../hamperhub/catalog.js";
import { TOOL_DECLARATIONS } from "../hamperhub/tools.js";
import { ALL_INVARIANTS } from "../policy/invariants/index.js";
import type { Policy } from "../policy/schema.js";
import type { JourneyCommerce } from "../runner/run.js";
import type { Violation } from "../policy/violations.js";
import type { JourneyResult, SuiteResult } from "../runner/run.js";
import type { Db } from "./client.js";

export interface PersistContext {
  policy: Policy;
  policyVersion: string;
  integrationVariant: string;
  generatorModel: string | null;
  generatorIsReal: boolean;
  /** The model given the adversary role, when roles were split. Null when they were not. */
  adversaryModel?: string | null;
  paymentAdapter: string | null;
  merchant?: Merchant;
}

export interface PersistedSuite {
  suiteId: string;
  testRunIds: string[];
}

/**
 * Writes a completed suite and everything under it.
 *
 * One transaction for the whole tree: a half-written suite would be worse than
 * none, because a reader could not tell a missing violation from a passing
 * journey. Reference data (merchant, catalog, tools, policy rules) is upserted
 * first so the run's rows have something to point at.
 */
export async function persistSuite(
  db: Db,
  suite: SuiteResult,
  ctx: PersistContext,
): Promise<PersistedSuite> {
  const merchant = ctx.merchant ?? HAMPERHUB;

  return db.transaction(async (client) => {
    await upsertMerchant(client, merchant);
    await upsertCatalog(client, merchant.id);
    await upsertTools(client, merchant.id);
    await upsertPolicy(client, ctx, merchant.id);

    const suiteId = randomUUID();
    await client.query(
      `insert into suites (
         id, label, policy_version, merchant_id, mutations, integration_variant,
         generator_model, generator_is_real, adversary_model, payment_adapter,
         passed, safely_rejected, escalated, unsafe_violations, inconclusive,
         errored,
         money_critical_escapes, money_at_risk_minor, audit_chain_ok, readiness,
         duration_ms, metrics, result
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
      [
        suiteId,
        suite.runId,
        ctx.policyVersion,
        merchant.id,
        suite.mutations,
        ctx.integrationVariant,
        ctx.generatorModel,
        ctx.generatorIsReal,
        ctx.adversaryModel ?? null,
        ctx.paymentAdapter,
        suite.passed,
        suite.safelyRejected,
        suite.escalated,
        suite.unsafeViolations,
        suite.inconclusive,
        suite.errored,
        suite.moneyCriticalEscapes,
        suite.moneyAtRiskMinor,
        suite.auditChainOk,
        suite.readiness,
        suite.durationMs,
        JSON.stringify(suite.metrics),
        // Exact snapshot for replay. See the note in schema.sql: the normalised
        // tables are for querying across runs, this is for reproducing one
        // faithfully rather than approximately.
        JSON.stringify(suite),
      ],
    );

    const testRunIds: string[] = [];
    for (const journey of suite.journeys) {
      testRunIds.push(await insertJourney(client, suiteId, journey));
    }

    return { suiteId, testRunIds };
  });
}

async function insertJourney(
  client: PoolClient,
  suiteId: string,
  journey: JourneyResult,
): Promise<string> {
  const testRunId = randomUUID();
  const intentId =
    journey.auditTrail.find((e) => e.intentId)?.intentId ?? null;

  await client.query(
    `insert into test_scenarios (id, title, category, source, targets_invariant, utterance, constraints)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (id) do update set
       title = excluded.title,
       category = excluded.category,
       targets_invariant = excluded.targets_invariant`,
    [
      journey.scenarioId,
      journey.title,
      journey.category,
      journey.scenarioId.startsWith("gen-") ? "generated" : "regression",
      journey.targetsInvariant,
      utteranceOf(journey) ?? journey.title,
      JSON.stringify(constraintsOf(journey) ?? {}),
    ],
  );

  await client.query(
    `insert into test_runs (
       id, suite_id, scenario_id, run_label, intent_id, title, category,
       driver, model,
       targets_invariant, disposition, note, fired_invariants,
       money_at_risk_minor, provider_orders, duplicate_payable_orders,
       self_rejected, audit_events, audit_chain_ok, duration_ms,
       ms_to_first_violation, error
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
    [
      testRunId,
      suiteId,
      journey.scenarioId,
      journey.auditTrail[0]?.runId ?? journey.scenarioId,
      intentId,
      journey.title,
      journey.category,
      journey.driver,
      journey.model,
      journey.targetsInvariant,
      journey.disposition,
      journey.note,
      journey.firedInvariants,
      journey.moneyAtRiskMinor,
      journey.providerOrders,
      journey.duplicatePayableOrders,
      journey.selfRejected,
      journey.auditEvents,
      journey.auditChainOk,
      journey.durationMs,
      journey.msToFirstViolation,
      journey.error,
    ],
  );

  await insertToolExecutions(client, testRunId, journey.auditTrail);
  await insertViolations(client, testRunId, journey.violations, "violation");
  await insertViolations(client, testRunId, journey.escalations, "escalation");
  await insertAuditEvents(client, testRunId, journey.auditTrail);
  await insertCommerce(client, testRunId, journey.commerce);

  return testRunId;
}

/**
 * Derives tool executions from the audit trail.
 *
 * The trail already pairs each `agent.tool_requested` with the outcome event that
 * follows it, so this reads the record of what happened rather than asking the
 * agent to report on itself.
 */
async function insertToolExecutions(
  client: PoolClient,
  testRunId: string,
  events: readonly AuditEvent[],
): Promise<void> {
  let seq = 0;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!;
    if (event.type !== "agent.tool_requested") continue;

    // The next event carrying a decision or an execution result is the outcome.
    const outcome = events
      .slice(i + 1)
      .find(
        (e) =>
          e.type === "tool.executed" ||
          e.type === "tool.rejected" ||
          e.type === "quote.created" ||
          e.type === "quote.approved" ||
          e.type === "checkout.requested" ||
          e.type === "checkout.blocked" ||
          e.type === "payment.verified" ||
          e.type === "payment.failed" ||
          e.type === "agent.tool_requested",
      );

    const failed =
      outcome === undefined ||
      outcome.type === "tool.rejected" ||
      outcome.type === "checkout.blocked" ||
      outcome.type === "payment.failed";

    seq += 1;
    await client.query(
      `insert into tool_executions (test_run_id, seq, tool_name, arguments, ok, summary)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (test_run_id, seq) do nothing`,
      [
        testRunId,
        seq,
        event.toolName ?? "unknown",
        JSON.stringify(event.input ?? {}),
        !failed,
        outcome?.reason ?? (failed ? "no outcome recorded" : "ok"),
      ],
    );
  }
}

/**
 * The commerce lifecycle: quotes, receipts, checkout intents, payments, orders.
 *
 * These five tables were in the schema from the start and written by nothing, so a
 * reader querying `checkout_intents` for what a run bought got an empty set and a
 * partial unique index on that table protected nothing at all. Money comes straight off
 * the entities in minor units — never from audit `output` blobs, which are
 * `toMajor()`-rounded for display and would silently lose paise.
 */
async function insertCommerce(
  client: PoolClient,
  testRunId: string,
  commerce: JourneyCommerce,
): Promise<void> {
  for (const q of commerce.quotes) {
    await client.query(
      `insert into quotes (id, test_run_id, version, intent_id, currency, line_items,
                           subtotal_minor, discounts, total_discount_minor, total_minor,
                           policy_version, reservation_id, status, created_at, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       on conflict (test_run_id, id) do nothing`,
      [
        q.id,
        testRunId,
        q.version,
        q.intentId,
        q.currency,
        JSON.stringify(q.lineItems ?? []),
        q.subtotalMinor,
        JSON.stringify(q.discounts ?? []),
        q.totalDiscountMinor,
        q.totalMinor,
        q.policyVersion,
        q.reservationId ?? null,
        q.status,
        q.createdAt.toISOString(),
        q.expiresAt.toISOString(),
      ],
    );
  }

  for (const a of commerce.approvals) {
    await client.query(
      `insert into approval_receipts (id, test_run_id, quote_id, quote_version, intent_id,
                                     approved_amount_minor, currency, confirmation_text,
                                     approved_content_hash, policy_version, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       on conflict (test_run_id, id) do nothing`,
      [
        a.id,
        testRunId,
        a.quoteId,
        a.quoteVersion,
        a.intentId,
        a.approvedAmountMinor,
        a.currency,
        a.confirmationText,
        a.approvedContentHash,
        a.policyVersion,
        a.createdAt.toISOString(),
      ],
    );
  }

  for (const c of commerce.checkoutIntents) {
    await client.query(
      `insert into checkout_intents (id, test_run_id, intent_id, quote_id, quote_version,
                                    approval_receipt_id, idempotency_key, amount_minor,
                                    currency, status, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       on conflict (test_run_id, id) do nothing`,
      [
        c.id,
        testRunId,
        c.intentId,
        c.quoteId,
        c.quoteVersion,
        c.approvalReceiptId ?? null,
        c.idempotencyKey,
        c.amountMinor,
        c.currency,
        c.status,
        c.createdAt.toISOString(),
      ],
    );
  }

  for (const p of commerce.paymentAttempts) {
    await client.query(
      `insert into payment_attempts (id, test_run_id, checkout_intent_id, provider_order_id,
                                    provider_payment_id, amount_minor, currency, status,
                                    verified, hosted_url, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       on conflict (test_run_id, id) do nothing`,
      [
        p.id,
        testRunId,
        p.checkoutIntentId,
        p.providerOrderId,
        p.providerPaymentId ?? null,
        p.amountMinor,
        p.currency,
        p.status,
        p.verified,
        p.hostedUrl ?? null,
        p.createdAt.toISOString(),
      ],
    );
  }

  for (const o of commerce.orders) {
    await client.query(
      `insert into orders (id, test_run_id, checkout_intent_id, payment_attempt_id,
                           amount_minor, currency, status, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (test_run_id, id) do nothing`,
      [
        o.id,
        testRunId,
        o.checkoutIntentId,
        o.paymentAttemptId,
        o.amountMinor,
        o.currency,
        o.status,
        o.createdAt.toISOString(),
      ],
    );
  }
}

async function insertViolations(
  client: PoolClient,
  testRunId: string,
  violations: readonly Violation[],
  kind: "violation" | "escalation",
): Promise<void> {
  for (const v of violations) {
    await client.query(
      `insert into violations (
         id, test_run_id, invariant_id, title, severity, attribution, kind,
         checkpoint, policy_refs, message, observed, expected,
         money_at_risk_minor, remediation, quote_id, occurred_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       on conflict (test_run_id, id, checkpoint) do nothing`,
      [
        v.id,
        testRunId,
        v.invariantId,
        v.title,
        v.severity,
        v.attribution,
        kind,
        v.checkpoint,
        v.policyRefs,
        v.message,
        JSON.stringify(v.observed ?? {}),
        JSON.stringify(v.expected ?? {}),
        v.moneyAtRiskMinor,
        v.remediation,
        v.quoteId,
        v.at.toISOString(),
      ],
    );
  }
}

async function insertAuditEvents(
  client: PoolClient,
  testRunId: string,
  events: readonly AuditEvent[],
): Promise<void> {
  for (const e of events) {
    await client.query(
      `insert into audit_events (
         test_run_id, seq, occurred_at, type, run_label, intent_id, tool_name,
         input, output, policy_version, decision, reason, quote_id,
         provider_order_id, violation_ids, prev_hash, hash
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       on conflict (test_run_id, seq) do nothing`,
      [
        testRunId,
        e.seq,
        e.at.toISOString(),
        e.type,
        e.runId,
        e.intentId,
        e.toolName,
        e.input === null || e.input === undefined ? null : JSON.stringify(e.input),
        e.output === null || e.output === undefined
          ? null
          : JSON.stringify(e.output),
        e.policyVersion,
        e.decision,
        e.reason,
        e.quoteId,
        e.providerOrderId,
        e.violationIds ?? [],
        e.prevHash,
        e.hash,
      ],
    );
  }
}

// -- reference data ---------------------------------------------------------

async function upsertMerchant(
  client: PoolClient,
  merchant: Merchant,
): Promise<void> {
  await client.query(
    `insert into merchants (id, name, currency) values ($1,$2,$3)
     on conflict (id) do update set name = excluded.name`,
    [merchant.id, merchant.name, merchant.currency],
  );
}

/**
 * Stores the seed catalog, not live state.
 *
 * Live prices and stock move constantly during a run; a snapshot of them would
 * be a lie by the time anyone read it. Per-journey drift is already visible in
 * the audit events and quote line items, which capture the versions in force at
 * the moment of each decision.
 */
async function upsertCatalog(
  client: PoolClient,
  merchantId: string,
): Promise<void> {
  for (const product of SEED_CATALOG) {
    await client.query(
      `insert into products (
         id, merchant_id, name, category, price_minor, price_version,
         allergens, vegan, bundle_eligible, min_price_minor
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (merchant_id, id) do update set
         name = excluded.name,
         price_minor = excluded.price_minor,
         allergens = excluded.allergens,
         vegan = excluded.vegan`,
      [
        product.id,
        merchantId,
        product.name,
        product.category,
        product.priceMinor,
        product.priceVersion,
        product.allergens,
        product.vegan,
        product.bundleEligible,
        product.minPriceMinor,
      ],
    );
    await client.query(
      `insert into inventory_records (product_id, merchant_id, available, reserved, version)
       values ($1,$2,$3,$4,$5)
       on conflict (merchant_id, product_id) do update set
         available = excluded.available`,
      [product.id, merchantId, SEED_INVENTORY[product.id] ?? 0, 0, 1],
    );
  }
}

async function upsertTools(
  client: PoolClient,
  merchantId: string,
): Promise<void> {
  for (const tool of TOOL_DECLARATIONS) {
    await client.query(
      `insert into commerce_tools (name, merchant_id, description, parameters)
       values ($1,$2,$3,$4)
       on conflict (merchant_id, name) do update set
         description = excluded.description,
         parameters = excluded.parameters`,
      [tool.name, merchantId, tool.description, JSON.stringify(tool.parameters)],
    );
  }
}

async function upsertPolicy(
  client: PoolClient,
  ctx: PersistContext,
  merchantId: string,
): Promise<void> {
  await client.query(
    `insert into policies (version, policy_id, merchant_id, currency, document)
     values ($1,$2,$3,$4,$5)
     on conflict (version) do nothing`,
    [
      ctx.policyVersion,
      ctx.policy.policyId,
      merchantId,
      ctx.policy.currency,
      JSON.stringify(ctx.policy.source),
    ],
  );

  for (const invariant of ALL_INVARIANTS) {
    await client.query(
      `insert into policy_rules (
         id, policy_version, title, severity, attribution, policy_refs, checkpoints
       ) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (policy_version, id) do update set
         title = excluded.title,
         severity = excluded.severity,
         attribution = excluded.attribution`,
      [
        invariant.id,
        ctx.policyVersion,
        invariant.title,
        invariant.severity,
        invariant.attribution,
        invariant.policyRefs,
        [...invariant.appliesAt],
      ],
    );
  }
}

// -- helpers ----------------------------------------------------------------

function utteranceOf(journey: JourneyResult): string | null {
  const intent = journey.auditTrail.find((e) => e.type === "intent.received");
  const input = intent?.input as { utterance?: string } | undefined;
  return input?.utterance ?? null;
}

function constraintsOf(
  journey: JourneyResult,
): Record<string, unknown> | null {
  const intent = journey.auditTrail.find((e) => e.type === "intent.received");
  const input = intent?.input as
    | { constraints?: Record<string, unknown> }
    | undefined;
  return input?.constraints ?? null;
}
