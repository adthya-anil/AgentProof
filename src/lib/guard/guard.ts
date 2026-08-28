import type { AuditLog } from "../audit/log.js";
import type { Clock } from "../core/clock.js";
import { type Minor, formatMinor, rupees, toMajor } from "../core/money.js";
import type {
  ApprovalReceipt,
  BuyerIntent,
  CheckoutIntent,
  PaymentAttempt,
  Quote,
} from "../core/types.js";
import {
  CommerceError,
  type HamperHubService,
} from "../hamperhub/service.js";
import type { MerchantState } from "../hamperhub/state.js";
import { TOOL_SCHEMAS, type ToolName } from "../hamperhub/tools.js";
import { PaymentProviderError } from "../payments/provider.js";
import { type PolicyEngine, type PolicyEvaluation } from "../policy/engine.js";
import type { CatalogSource } from "../merchant/source.js";
import { LocalCatalogSource } from "../merchant/source.js";
import type { Checkpoint } from "../policy/invariants/types.js";
import type { Policy } from "../policy/schema.js";
import type { Violation } from "../policy/violations.js";

export type ToolResult =
  | { ok: true; data: unknown; evaluation?: PolicyEvaluation }
  | {
      ok: false;
      /** True when the Guard stopped this, false when the merchant rejected it. */
      blockedByGuard: boolean;
      decision: "block" | "escalate" | "rejected" | "invalid";
      reason: string;
      violations: Violation[];
      /** Whether any money actually moved before the failure. */
      financialActionTaken: boolean;
    };

/**
 * Anything that can execute a commerce tool call on the agent's behalf.
 *
 * The Guard is the real implementation. Extracting the interface lets a
 * perturbation layer sit between the agent and the Guard — injecting latency,
 * duplicating a delivery, replaying an earlier request — without the agent or
 * the Guard knowing it is there. Crucially the wrapper cannot weaken any
 * verdict: it can only decide *what* gets called, never whether it is allowed.
 */
export interface ToolCaller {
  callTool(name: ToolName, rawArgs: unknown): Promise<ToolResult>;
}

export interface GuardOptions {
  clock: Clock;
  policy: Policy;
  policyVersion: string;
  engine: PolicyEngine;
  service: HamperHubService;
  state: MerchantState;
  audit: AuditLog;
  /** Runtime mode still blocks; preflight mode additionally records findings. */
  mode?: "preflight" | "runtime";
  /**
   * Identity of the payment provider actually in use.
   *
   * The audit trail must never say "Razorpay" when the order was simulated
   * offline. A reader has to be able to tell, from the trace alone, whether real
   * money was ever in play.
   */
  paymentProvider?: { name: string; isReal: boolean };
  /**
   * Where catalogue state comes from, and therefore what can be checked.
   *
   * Defaults to the in-process merchant, which is every existing run. An adapter
   * fronting a real REST or GraphQL catalogue supplies fewer capabilities, and the
   * engine then withholds the rules whose inputs are absent rather than running them
   * against undefined.
   */
  catalog?: CatalogSource;
}

/**
 * AgentProof Guard.
 *
 * Every commerce tool call from a buyer agent passes through here. The Guard
 * validates arguments, executes the merchant operation, evaluates the
 * deterministic policy at the relevant lifecycle checkpoint, and writes an audit
 * entry for the decision.
 *
 * The structural guarantee: the agent can call `create_checkout`, but only the
 * Guard can call `authorizeCheckout`. A payable order cannot come into existence
 * without an `allow` verdict, because the agent has no path to the payment
 * provider at all.
 *
 * The same instance is used for preflight and for runtime enforcement — a rule
 * that passes in testing is the identical code path that runs in production.
 */
export class Guard {
  private violations: Violation[] = [];
  private escalations: Violation[] = [];
  private evaluations: PolicyEvaluation[] = [];
  /** Set once any payable order has been created for the current intent. */
  private financialActionTaken = false;
  private provisionalCounter = 0;

  constructor(private readonly opts: GuardOptions) {}

  private intent!: BuyerIntent;

  /** Binds the Guard to a buyer intent and opens the audit trail for it. */
  /** Unsubscribes the state-change observer when a journey ends. */
  private unobserveState: (() => void) | undefined;

  /**
   * Provider order ids already recorded in this journey.
   *
   * Lets a repeated authorisation be reported as a reconciliation rather than a
   * second creation.
   */
  private seenProviderOrderIds = new Set<string>();

  beginIntent(intent: BuyerIntent): void {
    this.intent = intent;
    this.financialActionTaken = false;
    this.seenProviderOrderIds.clear();
    this.opts.audit.append({
      type: "intent.received",
      runId: intent.runId,
      intentId: intent.id,
      input: {
        utterance: intent.utterance,
        constraints: {
          ...intent.constraints,
          maxBudget:
            intent.constraints.maxBudgetMinor === null
              ? null
              : toMajor(intent.constraints.maxBudgetMinor),
        },
      },
      policyVersion: this.opts.policyVersion,
    });

    /**
     * Record price and stock movements for the rest of this journey.
     *
     * The trail used to show `INV-PRICE-BINDING` firing with no entry saying a
     * price had moved: a quote agreed, an approval, then a checkout blocked for
     * "catalog prices changed", and nothing anywhere recording what changed, when
     * or why. The cause of the most interesting violations was the one thing
     * missing from the record of them.
     *
     * Subscribed here rather than at construction so every entry carries the
     * journey's own run and intent ids, which is what makes the change attributable
     * to the transaction it interfered with.
     */
    this.unobserveState?.();
    this.unobserveState = this.opts.state.observeChanges((change) => {
      this.audit("catalog.state_changed", {
        reason: change.reason,
        output: {
          kind: change.kind,
          product_id: change.productId,
          // Prices are minor units; stock is a count. Reporting both raw keeps
          // this honest rather than guessing at a formatter per kind.
          from: change.kind === "price" ? toMajor(change.from) : change.from,
          to: change.kind === "price" ? toMajor(change.to) : change.to,
          new_version: change.newVersion,
        },
      });
    });
  }

  /** Stops recording state changes for the finished journey. */
  endIntent(): void {
    this.unobserveState?.();
    this.unobserveState = undefined;
  }

  /**
   * A fresh Guard over the same merchant state, service and audit log.
   *
   * Concurrent buyers must contend for real stock, so they cannot each have their
   * own environment. But they must not share violation bookkeeping either, or a
   * finding could not be attributed to the buyer that caused it. Forking gives
   * per-buyer accounting over shared state — which is exactly the situation a
   * reservation race needs.
   */
  forkForConcurrentBuyer(): Guard {
    return new Guard(this.opts);
  }

  /**
   * Points the Guard at a different catalogue.
   *
   * Separate from the constructor option so an environment can be built once and then
   * aimed at a mapped merchant — which is what the adapter tests and a future
   * multi-merchant run both need. Changing it mid-journey would mean two checkpoints
   * were evaluated against different merchants, so this is intended for setup only.
   */
  setCatalogSource(catalog: CatalogSource): void {
    this.opts.catalog = catalog;
  }

  recordedViolations(): readonly Violation[] {
    return this.violations;
  }

  recordedEscalations(): readonly Violation[] {
    return this.escalations;
  }

  allEvaluations(): readonly PolicyEvaluation[] {
    return this.evaluations;
  }

  hasFinancialAction(): boolean {
    return this.financialActionTaken;
  }

  // -----------------------------------------------------------------------

  async callTool(name: ToolName, rawArgs: unknown): Promise<ToolResult> {
    const runId = this.intent.runId;

    this.opts.audit.append({
      type: "agent.tool_requested",
      runId,
      intentId: this.intent.id,
      toolName: name,
      input: rawArgs,
      policyVersion: this.opts.policyVersion,
    });

    const schema = TOOL_SCHEMAS[name];
    const parsed = schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      const reason = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      this.opts.audit.append({
        type: "tool.rejected",
        runId,
        intentId: this.intent.id,
        toolName: name,
        decision: "block",
        reason: `Invalid arguments — ${reason}`,
        policyVersion: this.opts.policyVersion,
      });
      return {
        ok: false,
        blockedByGuard: true,
        decision: "invalid",
        reason: `Invalid arguments for ${name}: ${reason}`,
        violations: [],
        financialActionTaken: false,
      };
    }

    try {
      switch (name) {
        case "search_products":
          return this.handleSearch(parsed.data as SearchArgs);
        case "create_bundle":
          return this.handleCreateBundle(parsed.data as BundleArgs);
        case "create_quote":
          return await this.handleCreateQuote(parsed.data as QuoteArgs);
        case "approve_quote":
          return await this.handleApproveQuote(parsed.data as ApproveArgs);
        case "create_checkout":
          return await this.handleCreateCheckout(parsed.data as CheckoutArgs);
        case "get_payment_status":
          return await this.handlePaymentStatus(parsed.data as StatusArgs);
        default: {
          const exhaustive: never = name;
          throw new Error(`Unhandled tool ${String(exhaustive)}`);
        }
      }
    } catch (error) {
      return this.handleThrown(name, error);
    }
  }

  // -- tool handlers -------------------------------------------------------

  private handleSearch(args: SearchArgs): ToolResult {
    const products = this.opts.service.searchProducts({
      query: args.query,
      category: args.category,
      maxPriceMinor:
        args.max_price === undefined ? undefined : rupees(args.max_price),
      requireVegan: args.require_vegan,
      excludeAllergens: args.exclude_allergens,
    });

    const data = products.map((product) => ({
      product_id: product.id,
      name: product.name,
      category: product.category,
      price: toMajor(product.priceMinor),
      // Unknown data is surfaced as null to the agent, never as a safe default.
      allergens: product.allergens,
      vegan: product.vegan,
      in_stock: this.opts.state.freeStock(product.id),
    }));

    this.audit("tool.executed", {
      toolName: "search_products",
      output: { count: data.length },
      decision: "allow",
      reason: `${data.length} products matched`,
    });
    return { ok: true, data };
  }

  private handleCreateBundle(args: BundleArgs): ToolResult {
    const bundle = this.opts.service.createBundle({
      intentId: this.intent.id,
      items: args.items.map((item) => ({
        productId: item.product_id,
        quantity: item.quantity,
      })),
      promoCodes: args.promo_codes,
    });

    this.audit("tool.executed", {
      toolName: "create_bundle",
      output: { bundle_id: bundle.id, items: bundle.items.length },
      decision: "allow",
      reason: `Bundle with ${bundle.items.length} line(s)`,
    });
    return {
      ok: true,
      data: {
        bundle_id: bundle.id,
        items: bundle.items.map((i) => ({
          product_id: i.productId,
          quantity: i.quantity,
        })),
        promo_codes: bundle.promoCodes,
      },
    };
  }

  /**
   * Prices a bundle, then evaluates policy before the quote is ever shown to a
   * buyer. Blocking here is what stops an over-discounted price being offered in
   * the first place, rather than catching it at payment.
   */
  private async handleCreateQuote(args: QuoteArgs): Promise<ToolResult> {
    const { quote, rejectedPromos } = await this.opts.service.createQuote({
      intentId: this.intent.id,
      bundleId: args.bundle_id,
    });

    this.audit("quote.created", {
      toolName: "create_quote",
      quoteId: quote.id,
      output: {
        ...this.quoteSummary(quote),
        /**
         * Promotions the merchant refused, and why.
         *
         * The agent was already told this in the tool response; the audit log was
         * not. So a trace showed "subtotal ₹1,247, discounts ₹0" after a request
         * for FESTIVE10, and a reader could not tell a correctly refused 10%
         * promotion from one silently swallowed. A discount declined against a
         * policy cap is a money-relevant decision, which is exactly what this log
         * exists to record.
         */
        rejected_promo_codes: rejectedPromos,
      },
    });

    const evaluation = await this.evaluate("quote.created", { quote });
    if (evaluation.decision === "block" || evaluation.decision === "escalate") {
      // Never hold stock for a quote that cannot legally be sold.
      this.opts.service.releaseQuoteReservation(quote.id);
      this.audit("reservation.released", {
        quoteId: quote.id,
        reason: "Quote failed policy evaluation",
        decision: evaluation.decision,
      });
      return this.blockedResult(evaluation, false);
    }

    return {
      ok: true,
      evaluation,
      data: {
        ...this.quoteSummary(quote),
        rejected_promo_codes: rejectedPromos,
      },
    };
  }

  /**
   * Evaluates expiry *before* minting a receipt, so an approval can never be
   * bound to a quote the merchant has already stopped honouring.
   */
  private async handleApproveQuote(args: ApproveArgs): Promise<ToolResult> {
    const quote = this.opts.service.getQuote(args.quote_id);
    if (!quote) {
      throw new CommerceError("unknown_quote", `No such quote: ${args.quote_id}`);
    }

    const preEvaluation = await this.evaluate("quote.approved", { quote });
    if (preEvaluation.decision === "block") {
      return this.blockedResult(preEvaluation, false);
    }

    const receipt = this.opts.service.approveQuote({
      intentId: this.intent.id,
      quoteId: args.quote_id,
      approvedAmountMinor: rupees(args.approved_amount),
      confirmationText: args.confirmation_text,
    });

    this.audit("quote.approved", {
      toolName: "approve_quote",
      quoteId: quote.id,
      output: {
        approval_receipt_id: receipt.id,
        approved_amount: toMajor(receipt.approvedAmountMinor),
        quote_version: receipt.quoteVersion,
      },
      decision: "allow",
      reason: `Buyer approved ${formatMinor(receipt.approvedAmountMinor)}`,
    });

    return {
      ok: true,
      data: {
        approval_receipt_id: receipt.id,
        quote_id: receipt.quoteId,
        quote_version: receipt.quoteVersion,
        approved_amount: toMajor(receipt.approvedAmountMinor),
      },
    };
  }

  /**
   * The money-critical path.
   *
   * Order of operations is the whole point: build the intent, re-read live state,
   * evaluate every invariant, and only then touch the payment provider.
   */
  private async handleCreateCheckout(args: CheckoutArgs): Promise<ToolResult> {
    const quote = this.opts.service.getQuote(args.quote_id);
    if (!quote) {
      throw new CommerceError("unknown_quote", `No such quote: ${args.quote_id}`);
    }

    const approvalForPrecheck = args.approval_receipt_id
      ? (this.opts.service.getApproval(args.approval_receipt_id) ?? null)
      : null;

    let checkout: CheckoutIntent;
    try {
      checkout = this.opts.service.prepareCheckout({
        intentId: this.intent.id,
        quoteId: args.quote_id,
        approvalReceiptId: args.approval_receipt_id ?? null,
      });
    } catch (error) {
      if (!(error instanceof CommerceError)) throw error;

      // The merchant's own code rejected this. That is a safe outcome, but the
      // Guard still renders its own verdict: detection recall must not depend on
      // whether the integration happened to catch its own bug. This is how a
      // report can say "caught by the integration, and the Guard concurs".
      const provisional: CheckoutIntent = {
        id: `provisional_${(this.provisionalCounter += 1)}`,
        intentId: this.intent.id,
        quoteId: quote.id,
        quoteVersion: quote.version,
        approvalReceiptId: approvalForPrecheck?.id ?? null,
        idempotencyKey: "provisional",
        amountMinor: approvalForPrecheck?.approvedAmountMinor ?? quote.totalMinor,
        currency: quote.currency,
        createdAt: this.opts.clock.now(),
        status: "blocked",
      };

      const concurring = await this.evaluate("checkout.requested", {
        quote,
        approval: approvalForPrecheck,
        checkoutIntent: provisional,
        priorCheckoutIntents: this.opts.service.listCheckoutIntents(
          this.intent.id,
        ),
      });

      const released = this.opts.service.releaseQuoteReservation(quote.id);
      this.audit("checkout.blocked", {
        toolName: "create_checkout",
        quoteId: quote.id,
        decision: concurring.decision === "allow" ? "block" : concurring.decision,
        reason: `Merchant rejected: ${error.message}`,
        violationIds: [
          ...concurring.violations,
          ...concurring.escalations,
        ].map((v) => v.id),
        output: {
          rejected_by: "integration",
          code: error.code,
          guard_verdict: concurring.decision,
          guard_reason: concurring.reason,
          financial_action_taken: "none",
          reservation_released: released,
          required_next_action:
            "Create a new bundle and request fresh buyer approval.",
        },
      });

      return {
        ok: false,
        blockedByGuard: concurring.decision === "block",
        decision: concurring.decision === "escalate" ? "escalate" : "rejected",
        reason: error.message,
        violations: [...concurring.violations, ...concurring.escalations],
        financialActionTaken: false,
      };
    }

    this.audit("checkout.requested", {
      toolName: "create_checkout",
      quoteId: quote.id,
      output: {
        checkout_intent_id: checkout.id,
        amount: toMajor(checkout.amountMinor),
        idempotency_key: checkout.idempotencyKey,
        approval_receipt_id: checkout.approvalReceiptId,
      },
    });

    const approval = checkout.approvalReceiptId
      ? this.opts.service.getApproval(checkout.approvalReceiptId)
      : null;

    const evaluation = await this.evaluate("checkout.requested", {
      quote,
      approval,
      checkoutIntent: checkout,
      priorCheckoutIntents: this.opts.service.listCheckoutIntents(this.intent.id),
    });

    if (evaluation.decision === "block" || evaluation.decision === "escalate") {
      this.opts.service.markCheckoutBlocked(checkout.id);
      const released = this.opts.service.releaseQuoteReservation(quote.id);

      this.audit("checkout.blocked", {
        toolName: "create_checkout",
        quoteId: quote.id,
        decision: evaluation.decision,
        reason: evaluation.reason,
        violationIds: [...evaluation.violations, ...evaluation.escalations].map(
          (v) => v.id,
        ),
        output: {
          checkout_intent_id: checkout.id,
          financial_action_taken: "none",
          reservation_released: released,
          required_next_action:
            "Create a new bundle and request fresh buyer approval.",
        },
      });
      return this.blockedResult(evaluation, false);
    }

    // Guard authorised: this is the only place a payable order is created.
    const attempt = await this.opts.service.authorizeCheckout(checkout.id);
    this.financialActionTaken = true;

    const provider = this.opts.paymentProvider;
    const isRazorpay = provider?.isReal === true && provider.name === "razorpay";

    /**
     * Was an order created, or an existing one returned?
     *
     * A correct integration reconciles a repeated idempotency key by returning the
     * order it already made. The event said `payment.order_created` both times, so a
     * duplicated delivery produced two creation entries for one order — and the
     * journey that proves idempotency works was the one that looked like it had
     * created two payable orders.
     *
     * Recorded rather than inferred, because "the same id appears twice" is exactly
     * the ambiguity a reader should not have to resolve for themselves.
     */
    const reconciled = this.seenProviderOrderIds.has(attempt.providerOrderId);
    this.seenProviderOrderIds.add(attempt.providerOrderId);

    this.audit(
      isRazorpay ? "razorpay.order_created" : "payment.order_created",
      {
        toolName: "create_checkout",
        quoteId: quote.id,
        providerOrderId: attempt.providerOrderId,
        decision: "allow",
        reason: reconciled
          ? `Reconciled to existing order ${attempt.providerOrderId} — repeated ` +
            `idempotency key, no second order created`
          : `Authorised ${formatMinor(attempt.amountMinor)} after ${
              evaluation.evaluatedCount
            } invariants passed`,
        output: {
          payment_attempt_id: attempt.id,
          provider_order_id: attempt.providerOrderId,
          amount: toMajor(attempt.amountMinor),
          // False means an order was created here; true means one already existed
          // and was returned. The difference is whether money could move twice.
          reconciled,
          // Recorded explicitly so no reader has to infer it.
          provider: provider?.name ?? "unknown",
          provider_is_real: provider?.isReal ?? false,
        },
      },
    );

    return {
      ok: true,
      evaluation,
      data: {
        checkout_intent_id: checkout.id,
        payment_attempt_id: attempt.id,
        provider_order_id: attempt.providerOrderId,
        amount: toMajor(attempt.amountMinor),
        currency: attempt.currency,
        status: attempt.status,
      },
    };
  }

  private async handlePaymentStatus(args: StatusArgs): Promise<ToolResult> {
    const attempt = await this.opts.service.verifyPayment(
      args.payment_attempt_id,
    );
    const checkout = this.opts.service.getCheckoutIntent(attempt.checkoutIntentId);
    const quote = checkout ? this.opts.service.getQuote(checkout.quoteId) : null;
    const approval = checkout?.approvalReceiptId
      ? this.opts.service.getApproval(checkout.approvalReceiptId)
      : null;

    const evaluation = await this.evaluate("payment.verified", {
      quote,
      approval,
      checkoutIntent: checkout ?? null,
      paymentAttempt: attempt,
    });

    this.audit(attempt.status === "failed" ? "payment.failed" : "payment.verified", {
      toolName: "get_payment_status",
      quoteId: quote?.id ?? null,
      providerOrderId: attempt.providerOrderId,
      decision: evaluation.decision,
      reason: `Payment ${attempt.status}, verified=${attempt.verified}`,
      output: {
        payment_attempt_id: attempt.id,
        status: attempt.status,
        verified: attempt.verified,
        amount: toMajor(attempt.amountMinor),
      },
    });

    if (evaluation.decision === "block") {
      return this.blockedResult(evaluation, true);
    }

    return {
      ok: true,
      evaluation,
      data: {
        payment_attempt_id: attempt.id,
        status: attempt.status,
        verified: attempt.verified,
        amount: toMajor(attempt.amountMinor),
      },
    };
  }

  /**
   * Fulfilment is not an agent-callable tool — an agent must never be able to
   * mark goods as shipped. The runner calls this after payment verification.
   */
  async fulfillOrder(checkoutIntentId: string): Promise<ToolResult> {
    const checkout = this.opts.service.getCheckoutIntent(checkoutIntentId);
    if (!checkout) {
      return {
        ok: false,
        blockedByGuard: true,
        decision: "rejected",
        reason: `No such checkout intent: ${checkoutIntentId}`,
        violations: [],
        financialActionTaken: this.financialActionTaken,
      };
    }

    const attempt =
      this.opts.service.findPaymentAttemptForCheckout(checkoutIntentId) ?? null;
    const quote = this.opts.service.getQuote(checkout.quoteId) ?? null;
    const approval = checkout.approvalReceiptId
      ? this.opts.service.getApproval(checkout.approvalReceiptId)
      : null;

    // Ask the integration whether it would fulfil, before we decide. This is a
    // dry run with no side effects, and it is what lets the report distinguish
    // "the merchant would have refused too" from "only the Guard caught this".
    const merchantWould = this.opts.service.wouldFulfil(checkoutIntentId);

    const evaluation = await this.evaluate("order.fulfilled", {
      quote,
      approval,
      checkoutIntent: checkout,
      paymentAttempt: attempt,
    });

    if (evaluation.decision === "block") {
      if (!merchantWould.ok) {
        this.audit("tool.rejected", {
          quoteId: checkout.quoteId,
          decision: "block",
          reason: `Merchant declined fulfilment: ${merchantWould.reason}`,
          violationIds: evaluation.violations.map((v) => v.id),
          output: { rejected_by: "integration", guard_verdict: "block" },
        });
        return {
          ok: false,
          blockedByGuard: false,
          decision: "rejected",
          reason: `Merchant declined fulfilment: ${merchantWould.reason}`,
          violations: evaluation.violations,
          financialActionTaken: this.financialActionTaken,
        };
      }
      return this.blockedResult(evaluation, this.financialActionTaken);
    }

    try {
      const order = this.opts.service.fulfillOrder(checkoutIntentId);
      this.audit("merchant_order.confirmed", {
        quoteId: checkout.quoteId,
        decision: "allow",
        reason: `Order confirmed for ${formatMinor(order.amountMinor)}`,
        output: {
          order_id: order.id,
          amount: toMajor(order.amountMinor),
          payment_attempt_id: order.paymentAttemptId,
        },
      });
      return { ok: true, evaluation, data: { order_id: order.id } };
    } catch (error) {
      return this.handleThrown("create_checkout", error);
    }
  }

  // -- internals -----------------------------------------------------------

  private async evaluate(
    checkpoint: Checkpoint,
    parts: {
      quote?: Quote | null;
      approval?: ApprovalReceipt | null;
      checkoutIntent?: CheckoutIntent | null;
      paymentAttempt?: PaymentAttempt | null;
      priorCheckoutIntents?: readonly CheckoutIntent[];
    },
  ): Promise<PolicyEvaluation> {
    const source = this.opts.catalog ?? new LocalCatalogSource(this.opts.state);

    /**
     * Resolve every product this checkpoint could look at, once, before any rule runs.
     *
     * The alternative — letting each invariant fetch what it needs — would make
     * `evaluate` async on every rule and, worse, let two rules at the same checkpoint
     * observe different catalogue states. A report could then contain a price-binding
     * pass and an inventory violation computed against different prices, with nothing
     * in the output to show why they disagreed.
     *
     * The line items are the only source of product ids a rule can reach, so this is
     * the complete set rather than a guess at one.
     */
    const productIds = (parts.quote?.lineItems ?? []).map((line) => line.productId);
    const catalog = await source.viewFor(productIds);

    const evaluation = this.opts.engine.evaluate({
      checkpoint,
      policy: this.opts.policy,
      policyVersion: this.opts.policyVersion,
      clock: this.opts.clock,
      // Live state, deliberately re-read at every checkpoint — a fresh view each
      // time, never one carried over from the last.
      catalog,
      intent: this.intent,
      quote: parts.quote ?? null,
      approval: parts.approval ?? null,
      checkoutIntent: parts.checkoutIntent ?? null,
      paymentAttempt: parts.paymentAttempt ?? null,
      priorCheckoutIntents: parts.priorCheckoutIntents ?? [],
      capabilities: source.capabilities(),
    });

    this.evaluations.push(evaluation);
    this.violations.push(...evaluation.violations);
    this.escalations.push(...evaluation.escalations);

    this.audit("policy.evaluated", {
      quoteId: parts.quote?.id ?? null,
      decision: evaluation.decision,
      reason: evaluation.reason,
      violationIds: [...evaluation.violations, ...evaluation.escalations].map(
        (v) => v.id,
      ),
      output: {
        checkpoint,
        evaluated: evaluation.evaluatedCount,
        passed: evaluation.passedCount,
        skipped: evaluation.skippedCount,
        // Named, not just counted. "One rule did not apply" invites the question
        // "which one?", and that question is exactly how coverage is judged —
        // INV-PRODUCT-SAFETY skipping because no allergens were declared is
        // correct, whereas it skipping on an allergic buyer would be a hole.
        skippedInvariants: evaluation.results
          .filter((r) => r.status === "skipped" && !r.missingCapabilities)
          .map((r) => r.invariantId),
        /**
         * Rules that could not run here at all, kept separate from the ones that
         * merely had nothing to say.
         *
         * Inside the audit output rather than alongside it, because the chain is what
         * a merchant is asked to trust: a coverage gap that lives only in a dashboard
         * can be forgotten, while one written into the hash chain is part of the
         * record of what was and was not checked.
         */
        withheld: evaluation.unsupportedCount,
        withheldInvariants: evaluation.capabilityGaps.map((gap) => ({
          invariant: gap.invariantId,
          missing: [...gap.missing],
        })),
        violations: evaluation.violations.map((v) => ({
          invariant: v.invariantId,
          severity: v.severity,
          message: v.message,
          money_at_risk: toMajor(v.moneyAtRiskMinor),
        })),
        escalations: evaluation.escalations.map((v) => ({
          invariant: v.invariantId,
          message: v.message,
        })),
      },
    });

    return evaluation;
  }

  private blockedResult(
    evaluation: PolicyEvaluation,
    financialActionTaken: boolean,
  ): ToolResult {
    const all = [...evaluation.violations, ...evaluation.escalations];
    return {
      ok: false,
      blockedByGuard: true,
      decision: evaluation.decision === "escalate" ? "escalate" : "block",
      reason: all.map((v) => v.message).join(" "),
      violations: all,
      financialActionTaken,
    };
  }

  /** Merchant-side rejections and provider faults are outcomes, not crashes. */
  private handleThrown(toolName: ToolName, error: unknown): ToolResult {
    if (error instanceof CommerceError) {
      this.audit("tool.rejected", {
        toolName,
        decision: "block",
        reason: `Merchant rejected: ${error.message}`,
        output: { code: error.code },
      });
      return {
        ok: false,
        blockedByGuard: false,
        decision: "rejected",
        reason: error.message,
        violations: [],
        financialActionTaken: this.financialActionTaken,
      };
    }

    if (error instanceof PaymentProviderError) {
      this.audit("payment.failed", {
        toolName,
        decision: "block",
        reason: `Payment provider ${error.kind}: ${error.message}`,
        output: { kind: error.kind, retryable: error.retryable },
      });
      return {
        ok: false,
        blockedByGuard: false,
        decision: "rejected",
        reason: `${error.message}${error.retryable ? " (retryable)" : ""}`,
        violations: [],
        // A timeout may well have created an order. Never claim otherwise.
        financialActionTaken:
          error.kind === "timeout" ? true : this.financialActionTaken,
      };
    }

    throw error;
  }

  private quoteSummary(quote: Quote): Record<string, unknown> {
    return {
      quote_id: quote.id,
      quote_version: quote.version,
      currency: quote.currency,
      line_items: quote.lineItems.map((line) => ({
        product_id: line.productId,
        name: line.name,
        quantity: line.quantity,
        unit_price: toMajor(line.unitPriceMinor),
        line_total: toMajor(line.lineTotalMinor),
      })),
      subtotal: toMajor(quote.subtotalMinor),
      discounts: quote.discounts.map((d) => ({
        code: d.code,
        label: d.label,
        amount: toMajor(d.amountMinor),
      })),
      total_discount: toMajor(quote.totalDiscountMinor),
      total: toMajor(quote.totalMinor),
      expires_at: quote.expiresAt.toISOString(),
    };
  }

  private audit(
    type: Parameters<AuditLog["append"]>[0]["type"],
    fields: {
      toolName?: ToolName | null;
      quoteId?: string | null;
      providerOrderId?: string | null;
      decision?: PolicyEvaluation["decision"] | null;
      reason?: string | null;
      output?: unknown;
      input?: unknown;
      violationIds?: string[];
    },
  ): void {
    this.opts.audit.append({
      type,
      runId: this.intent.runId,
      intentId: this.intent.id,
      policyVersion: this.opts.policyVersion,
      ...fields,
    });
  }
}

type SearchArgs = {
  query?: string;
  category?: string;
  max_price?: number;
  require_vegan?: boolean;
  exclude_allergens?: string[];
};
type BundleArgs = {
  items: Array<{ product_id: string; quantity: number }>;
  promo_codes?: string[];
};
type QuoteArgs = { bundle_id: string };
type ApproveArgs = {
  quote_id: string;
  approved_amount: number;
  confirmation_text: string;
};
type CheckoutArgs = { quote_id: string; approval_receipt_id?: string | null };
type StatusArgs = { payment_attempt_id: string };

export type { Minor };
