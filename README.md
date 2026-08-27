# AgentProof

**Preflight testing and runtime policy layer for agentic commerce.**

> Test every path an AI buyer might take before money moves.

Traditional checkout tests follow a fixed script. AI buyers do not — they
interpret natural language, choose their own tool sequences, retry failed calls,
and adapt as prices and inventory change. Every individual API call can be valid
while the complete transaction is financially unsafe.

AgentProof sends autonomous buyer agents through a merchant's checkout, discovers
unsafe tool-call sequences, and enforces deterministic financial rules that block
invalid transactions before money moves.

**AI explores; deterministic code decides.**

---

## Current status

Phase 1 is complete: the deterministic core, the demo merchant, the seeded
defects, and the measured evaluation. Phase 2 (LLM buyer agent, AI scenario
generation, dashboard) is not built yet — see [Not built yet](#not-built-yet).

Everything claimed below is produced by a command in this repo.

```bash
npm install
npm test              # 82 tests
npm run typecheck
npm run demo:happy       # successful ₹1,399 transaction
npm run demo:blocked     # runtime block before any payment exists
npm run demo:defects     # the four headline seeded defects
npm run demo:preflight   # readiness report + fix-and-rerun + mutation scorecard
```

---

## Measured results

From `npm run demo:preflight`, 12 regression journeys against the same suite:

| | Vulnerable integration | Fixed integration |
|---|---|---|
| Passed | 2 | 3 |
| Safely rejected | 6 | 9 |
| Escalated for approval | 1 | 0 |
| Unsafe violations | 3 | 0 |
| Money-critical escapes | 0 | 0 |
| Money at risk (prevented) | ₹8,944.56 | ₹6,844.00 |
| **Readiness** | **NOT READY** | **READY FOR CONTROLLED TEST** |

Mutation evaluation, one mutant at a time:

```
Defect detection recall: 8/8 (100%)
False-positive rate: 0/12 safe journeys flagged (0%)
Unsafe money actions that escaped the Guard: 0
```

"Readiness report", never "certified" or "guaranteed safe" — no finite test suite
can prove the absence of defects. That is also why the same policy engine stays
active at runtime.

---

## How it works

```
Scenario suite → Buyer journey → AgentProof Guard → HamperHub commerce
                                       │                    │
                                  deterministic         two-phase
                                  invariants            checkout
                                       │                    │
                                  allow / block ──────→ payment provider
                                       │
                                  hash-chained audit log
```

Two components share one policy engine:

- **AgentProof Lab** — pre-deployment verification. Runs journeys against the
  real integration, perturbs state mid-flight, and produces a replayable report.
- **AgentProof Guard** — runtime enforcement. The identical invariants wrap the
  live tools, so a rule that passed preflight is the same code path in
  production.

### The structural guarantee

The buyer agent can *request* a checkout, but it has no path to the payment
provider at all. Checkout is deliberately two-phase:

1. `prepareCheckout` builds a checkout intent — nothing payable exists yet.
2. The Guard re-reads live state and evaluates every invariant.
3. Only on `allow` does the Guard call `authorizeCheckout`, which creates the
   provider order.

A payable order therefore cannot come into existence without a passing verdict,
by construction rather than by convention.

---

## The deterministic invariants

Twelve executable financial rules in `src/lib/policy/invariants/`. Pass/fail is
arithmetic — no invariant consults an LLM, and none knows which defect is active.

| Invariant | Rule |
|---|---|
| `INV-MAX-AMOUNT` | Transaction within the merchant's per-transaction ceiling |
| `INV-BUDGET` | Charge never exceeds the buyer-approved amount |
| `INV-DISCOUNT-CAP` | *Effective* combined discount within the cap |
| `INV-FLOOR-PRICE` | No line discounted below its minimum permitted price |
| `INV-PRICE-BINDING` | Checkout price matches the currently valid approved quote |
| `INV-INVENTORY` | Every quantity currently available and reserved |
| `INV-CONFIRMATION` | No payment without explicit approval for that exact quote |
| `INV-IDEMPOTENCY` | One checkout intent cannot create multiple payable orders |
| `INV-QUOTE-EXPIRY` | An expired quote cannot be used for payment |
| `INV-PRODUCT-SAFETY` | Unknown safety data is never treated as safe |
| `INV-PAYMENT-STATE` | Only a verified captured payment can fulfil an order |
| `INV-CURRENCY` | Quote, approval and payment currencies all match |

### Why the discount rule measures endpoints

The cap is checked against the effective discount, computed from the subtotal and
the payable total, not by summing the declared component rates:

```
4% then 4.9% applied sequentially = 1 - (0.96 × 0.951) = 8.7% effective
```

Both components are under a 5% cap. The result is not. Summing component rates
is exactly the mistake that lets this through; measuring the endpoints reports
the true 8.7% regardless of how the merchant layered its promotions.

---

## Honest measurement

Three design decisions exist specifically to keep the numbers meaningful.

**1. Attribution.** Every finding is attributed to `integration`, `agent`, or
`environment`. Only `integration` findings count as merchant defects. The Guard
blocking an agent that overspent the buyer's stated budget is the system working
as intended, not a bug in the merchant's code — so `INV-BUDGET`'s stated-budget
check is attributed to the agent. Without this the false-positive rate would be
inflated by correct behaviour.

**2. Self-rejection wins.** When the merchant's own code refuses an operation,
the journey is recorded as *safely rejected* even though the Guard concurs. The
Guard always renders its own verdict — including a concurring one, via a
side-effect-free `wouldFulfil` dry run — so detection recall never depends on
whether the integration happened to catch its own bug. But a correct integration
is never blamed for a defect it does not have.

**3. Mutation masking is measured, not hidden.** With several defects active at
once, an upstream block can prevent a downstream defect from ever being reached:
`missing_quote_expiry` issues 24-hour quotes, so `INV-QUOTE-EXPIRY` blocks at
approval and `INV-PRICE-BINDING` is never exercised. Recall is therefore measured
one mutant at a time, as in standard mutation testing. The masking behaviour has
its own test rather than being quietly averaged away.

---

## Seeded defects

`src/lib/hamperhub/mutations.ts` toggles eight realistic bugs. Mutations only
change the *merchant's* behaviour — they never touch the Guard or the invariants,
and the scenario suite is not told which is active.

| Mutation | Defect | Caught by |
|---|---|---|
| `discount_stacking` | Discounts validated individually, not cumulatively | `INV-DISCOUNT-CAP` |
| `missing_price_version_check` | Stale approval reused after a price change | `INV-PRICE-BINDING` |
| `missing_idempotency` | Retry after timeout opens a second payable order | `INV-IDEMPOTENCY` |
| `unknown_allergen_safe` | `allergens ?? []` turns unknown into allergen-free | `INV-PRODUCT-SAFETY` |
| `missing_quote_expiry` | Expiry never enforced | `INV-QUOTE-EXPIRY` |
| `missing_inventory_revalidation` | Stock trusted from quote time | `INV-INVENTORY` |
| `missing_buyer_confirmation` | Conversational reply read as approval | `INV-CONFIRMATION` |
| `incorrect_payment_state` | Order fulfilled before capture | `INV-PAYMENT-STATE` |

### Replayable failures

From `npm run demo:preflight`:

```
00:00  Buyer intent created: "Build a coffee hamper and apply every discount code I qualify for."
00:00  create_bundle executed — Bundle with 4 line(s)
00:00  Quote created: ₹1320.14 | HAMPER4 -₹57.84 | LOYAL49 -₹68.02
00:00  AgentProof verdict: CRITICAL VIOLATION [INV-DISCOUNT-CAP] Effective discount
       reached 8.7% against a 5% policy limit. Subtotal ₹1,446.00 discounted to
       ₹1,320.14 by 2 components applied in sequence.
00:00  Reservation released — Quote failed policy evaluation
```

The trace shows buyer messages, tool calls, state changes, policy evaluation and
the exact failed invariant — with concise decision explanations, never model
chain-of-thought.

---

## Runtime enforcement

`npm run demo:blocked` reproduces the graceful-failure case: the buyer approves
₹1,399, then a stock-take correction zeroes the coffee and breaks the hold.

```
Decision: BLOCKED
Reason:
  Arabica Single-Origin Coffee 250g: quantity 1 requested but 0 usable
  (stock now 0, inventory version v1 → v2)
Financial action taken:
  None
Required next action:
  Create a new bundle and request fresh buyer approval.

Provider orders created: 0
Payment attempts: 0
Reservation status: released
```

---

## Audit trail

Every run produces append-only events with a SHA-256 hash chain: each event's
hash covers its own canonical content plus the previous hash, so altering or
deleting any historical event invalidates every hash after it. `verify()` is what
lets us claim the replay a judge sees is the run that actually happened.

Credential-shaped keys are redacted before persistence as defence in depth, even
though the agent never holds payment credentials.

---

## Razorpay integration

`src/lib/payments/razorpay.ts` targets Razorpay test mode and **refuses to
construct** unless the key id starts with `rzp_test_` — AgentProof deliberately
attempts unsafe transactions, so it must never point at live keys.

One detail is worth stating because it is the crux of the product: the
[Orders API](https://razorpay.com/docs/api/orders/create/) has **no idempotency
header**. Razorpay offers `X-Payout-Idempotency` and `X-Refund-Idempotency`, but
order creation has neither — the only duplicate defence is that `receipt` must be
unique (max 40 characters), and enforcing that is the merchant's responsibility.

So an agent retrying a timed-out checkout will open a second payable order unless
the integration derives a stable receipt and refuses to reuse it. AgentProof
passes the Guard's idempotency key through as `receipt`, and `INV-IDEMPOTENCY`
blocks the second attempt before the adapter is called at all.

Preflight runs use a deterministic in-process provider (`FakePaymentProvider`)
because thousands of orders against a real sandbox would be slow, rate-limited,
and impossible to capture without a browser. It reproduces the behaviour that
matters: a create-order call that times out *after* the order was really created.

*Sources: Razorpay API documentation, retrieved for endpoint and idempotency
semantics. Content was rephrased for compliance with licensing restrictions.*

---

## Layout

```
policies/hamperhub-v1.yaml      Versioned merchant policy (the enforced contract)
src/lib/core/                   Money (integer paise), clock, ids, entities
src/lib/audit/                  Append-only hash-chained event log
src/lib/policy/                 Policy schema + engine + 12 invariants
src/lib/guard/                  AgentProof Guard
src/lib/hamperhub/              The merchant under test (+ seeded defects)
src/lib/payments/               Provider interface, Razorpay adapter, fake
src/lib/scenarios/              12 fixed regression scenarios
src/lib/runner/                 Journey execution and scoring
src/lib/report/                 Readiness report and trace replay
src/scripts/                    Runnable demos
tests/                          82 tests
```

Money is an integer count of paise throughout. Float rupees are banned: an
invariant that compares `1399.0000000000002 <= 1399` is worse than no invariant.

Time is injected everywhere, so quote expiry is a test input rather than a race
condition, and every run is reproducible from a seed.

---

## Not built yet

Honest scope. Phase 1 delivers the deterministic core; these remain:

- **LLM buyer agent** — journeys are currently scripted regression scenarios.
  The tool schemas and declarations the model needs are already defined in
  `src/lib/hamperhub/tools.ts`.
- **AI scenario generation** (§7B) — semantic and adversarial goal synthesis.
- **Next.js dashboard** (§8) — the report is currently CLI output.
- **A real Razorpay test-mode transaction** — the adapter is written but has not
  been exercised against a live sandbox, because no test credentials are
  configured. `PAYMENT_ADAPTER=razorpay` with `rzp_test_` keys switches it on.
- **Concurrency and journey volume** — 12 scenarios today, target 20–25.

## Configuration

Copy `.env.example` to `.env`. Defaults run fully offline and deterministically.

```
PAYMENT_ADAPTER=fake        # or "razorpay" with rzp_test_ credentials
LLM_ADAPTER=scripted        # deterministic; no API key needed
AGENTPROOF_SEED=1337        # reproducible demo runs
```

---

Traditional checkout tests whether the code works. AgentProof tests what an AI
buyer might actually do — and stops money from moving when it should not.
