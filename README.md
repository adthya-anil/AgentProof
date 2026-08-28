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

Both phases are built: the deterministic engine, the demo merchant, the seeded
defects and measured evaluation, plus the autonomous buyer agent, AI scenario
generation, the dashboard, and a real Razorpay test-mode path.

Everything claimed below is produced by a command in this repo. Nothing requires
an API key or network access unless you explicitly opt in.

```bash
npm install
npm test                    # 335 tests
npm run typecheck

npm run demo:happy          # successful ₹1,399 transaction
npm run demo:blocked        # runtime block before any payment exists
npm run demo:defects        # the four headline seeded defects
npm run demo:preflight      # 25 journeys: readiness report, metrics, scorecard
npm run demo:concurrency    # 5 buyers racing for 3 units of stock
npm run demo:razorpay       # real Razorpay test-mode payment (needs test keys)

npm run build && npm start  # dashboard on http://localhost:3000
                            # then open /preflight and press Run

npm run db:up               # optional: local Postgres for persisted runs
npm run db:migrate
npm run db:status
```

Nothing above requires a database, an API key, or network access. Those are all
opt-in, and the suite must pass without them.

---

## Measured results

From `npm run demo:preflight`: **25 journeys** (12 fixed regression +
4 state-perturbation + 9 AI-generated), the identical suite run against both
integrations, on the deterministic scripted model so the figures are reproducible.
Adding the live-agent half from `/preflight` roughly doubles the suite and the
outcomes will differ run to run — that is the point of it, and why it is reported
separately rather than averaged into this table.

| | Vulnerable integration | Fixed integration |
|---|---|---|
| Passed | 8 | 11 |
| Safely rejected | 10 | 13 |
| Escalated for approval | 2 | 1 |
| Unsafe violations | 5 | 0 |
| Money-critical escapes | 0 | 0 |
| Money at risk (prevented) | ₹16,224.18 | ₹12,607.00 |
| **Readiness** | **NOT READY** | **READY FOR CONTROLLED TEST** |

Mutation evaluation, one mutant at a time:

```
Defect detection recall: 8/8 (100%)
False-positive rate: 0/25 safe journeys flagged (0%)
Unsafe money actions that escaped the Guard: 0
```

Coverage and detection metrics, so a clean verdict can be interpreted rather than
just believed:

| Metric | Vulnerable | Fixed |
|---|---|---|
| Policy rules exercised | 12/12 (100%) | 12/12 (100%) |
| Distinct tool paths covered | 10 | 11 |
| Critical integration defects | 5 | 0 |
| Median time to first violation | 1ms | 1ms |
| Median tool calls to first violation | 4 | 4 |
| Duplicate payment attempts prevented | 2 | 0 |
| Unsafe money actions escaped | 0 | 0 |

"0 unsafe violations" means far less if only three of twelve rules were ever
exercised, or if every journey walked the same tool path. Publishing coverage
next to the verdict is what makes the verdict mean something.

One result worth singling out. The AI-generated adversarial journey
`gen-grab-every-discount` asked for *every* discount it qualified for, stacked
three promotions, and reached an **11.44% effective discount plus a floor-price
breach on four line items** — strictly worse than the 8.7% the hand-written
regression scenario finds, and a case nobody scripted. Generation earning its
place is exactly this: finding the path a developer would not have thought to
write down.

"Readiness report", never "certified" or "guaranteed safe" — no finite test suite
can prove the absence of defects. That is also why the same policy engine stays
active at runtime.

---

## How it works

```
Scenario generator          Buyer agent            AgentProof Guard
(fixed + AI-generated)  →  (LLM tool loop)   →   (12 deterministic
                                                    invariants)
                                                        │
                                            allow ─────┼───── block
                                              │           │
                                    HamperHub commerce   audit log
                                    (two-phase checkout) (hash-chained)
                                              │
                                    Razorpay test mode / offline fake
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

## The autonomous buyer agent

`src/lib/agent/` holds the agent that actually drives the journeys. It receives a
buyer intent and the commerce tool declarations, then chooses its own sequence of
tool calls, reacting to each result — the open-ended behaviour a fixed test script
cannot capture. Every call goes through the Guard, so its autonomy never extends
to moving money: it can *request* a checkout, but deterministic code decides
whether one happens.

Two interchangeable models sit behind one interface:

| Adapter | When | Behaviour |
|---|---|---|
| `scripted` (default) | no key, no network | Deterministic state machine. Reproducible byte-for-byte. |
| `openai` | `LLM_ADAPTER=openai` + `LLM_API_KEY` | Genuinely adaptive; any OpenAI-compatible endpoint. |

The scripted model is not a stub returning canned strings. It executes an ordered
plan whose arguments are resolved from earlier tool responses (`$ref:quote_id`
picks up the quote the merchant just issued), and it reproduces the *risky* moves
a real agent makes — stacking every discount it can find, trusting a filtered
search result, retrying after a timeout. The agent code path is byte-for-byte
identical either way, which is what lets a demo rehearsed on the scripted model
behave the same when pointed at a real one.

The agent is deliberately constrained: a hard tool-call budget so a looping model
always terminates, schema validation on every argument, and unknown tool names
rejected outright.

---

## AI scenario generation

`src/lib/scenarios/generate.ts` produces the semantic half of the suite. It reads
the tool schemas, the merchant policy, the catalog (including which products have
*unknown* allergen data) and any prior failures, then invents buyer goals —
ambiguous requests, adversarial framing, interacting constraints.

It never decides pass/fail. It only invents what the agent should attempt;
deterministic invariants still render every verdict. Generated scenarios also
declare no target invariant, so they cannot cheat their way to a detection.

Model output is schema-validated and deduplicated, and any strategy the model
tries to supply is **stripped** — real-LLM journeys run adaptively rather than
replaying a plan the model wrote for itself. If generation fails for any reason
the scripted set is used instead, so a preflight run never aborts because an
upstream provider had a bad minute.

---

## Dashboard

`npm run build && npm start` serves the report at `http://localhost:3000`.

| Route | Shows |
|---|---|
| `/hamperhub` | **The merchant under test**: catalog, tool surface, promotions |
| `/hamperhub/agent` | **Watch a buyer agent shop**, live, on either integration |
| `/live` | **Live agent console**: one journey, streamed decision by decision, either model |
| `/preflight` | **Start a run.** Streams every journey as it executes |
| `/` | Readiness, outcome counts, category coverage, journey table |
| `/violations` | Findings split by responsibility (see below) |
| `/journey/[id]` | Full replay: intent, tool calls, state changes, failed invariant |
| `/evaluation` | Mutation scorecard, recall, false-positive rate |
| `/audit` | Hash-chain status and every money-critical decision |
| `/policy` | The enforced policy and all 12 invariants |

Toggle between the vulnerable and fixed integrations from any page. Every page is
a server component apart from the two streaming consoles, and there is no
`next/font`, so the build needs no network.

### Runs are triggered, never automatic

Report pages read a stored run. They never execute one.

This was not always true, and the reason it changed matters. When journeys were
scripted a suite finished in ~50ms, so running one on every page load was free and
kept the report honest by construction. The moment a real model started driving
the agents that stopped being defensible: opening `/` would silently spend minutes
and real tokens on work nobody asked for, and with nine concurrent live agents the
page simply never finished loading.

So the flow is explicit:

1. Open `/preflight`, choose the integration and the composition, press **Run**.
2. The run streams over SSE — each journey appears as it starts and fills in as it
   finishes, with its tool path and the invariants that fired.
3. The result is stored in memory and mirrored to Postgres when `DATABASE_URL` is
   set. Every report page then reads it, instantly.

Before the first run, report pages say so and link to `/preflight` rather than
showing a stale or invented summary.

### Two model families, because a merchant doesn't get to choose

A merchant cannot pick which agent shops their store, so testing against one model
tests a narrower world than the one they ship into. AgentProof drives journeys
through both an OpenAI-compatible endpoint and the Anthropic Messages API, and
records **per journey** which model drove it.

Name a second deployment in `.env` and every live-agent goal runs twice — once per
model, same buyer request, same target invariant:

```
LLM_ADAPTER=openai
LLM_MODEL=gpt-5.6-sol
LLM_BASE_URL=https://<resource>.services.ai.azure.com/openai/v1
LLM_API_KEY=...

ANTHROPIC_MODEL=claude-opus-5
ANTHROPIC_BASE_URL=https://<resource>.services.ai.azure.com/anthropic
# ANTHROPIC_API_KEY falls back to LLM_API_KEY — one Foundry resource, one secret
```

Reports then gain a **Where the models differ** table, which is the point. From a
real run against the vulnerable integration, both models given the identical
request:

| Model | Effective discount reached | Invariants tripped |
|---|---|---|
| `gpt-5.6-sol` | 7.75% on ₹1,277 | `INV-DISCOUNT-CAP` |
| `claude-opus-5` | 14.23% on ₹1,496, 4 components stacked | `INV-DISCOUNT-CAP`, `INV-FLOOR-PRICE` |

Same store, same promotions, same buyer sentence. One model hunted harder for
promotions and broke through the floor price as well as the discount cap. A single
-model report would have found the first hole and missed the second — and a
merchant who tuned their integration against only that report would ship the gap.

The two adapters are not interchangeable under the hood, and the differences are
the kind that fail silently:

- **Tool schemas** are `input_schema` here, not a nested `function` wrapper.
- **`max_tokens` is mandatory**, unlike chat-completions.
- **There is no JSON response mode**, so scenario generation asks for bare JSON
  and leans on the existing tolerant extractor.
- **Signed `thinking` blocks** come back alongside a tool call. Rebuilding the
  assistant turn from our neutral message shape would silently drop them and throw
  away the model's reasoning chain mid-purchase, so the adapter round-trips the
  provider's own block list through an opaque `providerRaw` field.
- **Tool results must merge into one user turn.** They arrive as separate `tool`
  messages, and this API enforces strict role alternation — so the first time an
  agent calls two tools at once, unmerged results break the conversation.
- **`temperature` is rejected outright** by `claude-opus-5`. As with the Azure
  reasoning deployments, the adapter reads the 400, drops the field, retries, and
  remembers.

Each of those is pinned by a wire-level test, because every one of them returns a
plausible-looking 200 when it is subtly wrong.

### Fixed repro or live agent — always labelled

Every journey row says who chose the tool calls, because the two support very
different claims:

- **`fixed repro`** — a hand-written tool sequence. Identical on every run, which
  is the only honest basis for a recall number. A regression test for a known
  defect has to reproduce it the same way every time, or measured detection
  becomes a function of the model's mood. The four transport perturbations are
  labelled this way too: they route through an agent, but their steps are scripted
  so the duplicate delivery or clock jump has something stable to act on.
- **`live agent`** — a real model handed only the buyer's words and the tool
  surface. This is where failures nobody anticipated show up.

`/preflight` runs both by default. **Live agent only** hands all 12 regression
goals — same buyer request, same target invariant, no scripted steps — to every
configured model and reports what each actually does.

The two halves genuinely disagree, which is the argument for keeping both. On one
real run, `reg-05-duplicate-payment` was an `unsafe_violation` as a fixed repro —
the scripted journey forces the duplicate delivery and the missing idempotency key
lets a second payable order through — while both live models `passed` the same
goal, because neither tried to pay twice. Drop the deterministic half and you stop
detecting the defect; drop the live half and you never learn how a real agent
behaves.

### Paying a real link syncs on its own

A hosted payment link is asynchronous. The agent creates it, the Guard authorises
it, `INV-PAYMENT-STATE` refuses to fulfil while the payment is uncaptured — the
correct answer at that moment — and then a human goes and pays, minutes later.

Both halves of the sync exist, because they solve different problems:

- **Polling.** While a payment is outstanding the console asks Razorpay every four
  seconds, for up to five minutes. Pay in the other tab and the page updates on its
  own. This is what works on a laptop, since Razorpay cannot reach `localhost`.
- **Webhook** at `/api/razorpay/webhook`, for a deployed URL. Point Razorpay at it
  for `payment_link.paid` and `payment.captured`.

Two rules govern the webhook, and both are refusals:

1. **Nothing is believed until the HMAC signature verifies** against
   `RAZORPAY_WEBHOOK_SECRET`, in constant time, over the exact raw bytes. An unset
   secret rejects everything — it fails closed, because an unauthenticated webhook
   that marks orders paid is a way for anyone to have goods dispatched for free.
2. **The payload is a trigger, not a source of truth.** Even once verified, no
   amount or status is read out of it. The handler goes and asks Razorpay what
   happened and puts that answer through the same Guard checkpoints as everything
   else, so the settlement path is identical whether a person or a provider
   initiated it.

Verified against a running server: a forged signature, a missing signature, and a
valid signature over a swapped body are all `401`; an authentic event for a journey
no longer in memory is `200 matched=false`; and an event that is not a payment
completion is acknowledged and ignored rather than retried.

### Inconclusive is a real outcome

A live agent that exhausts its tool budget, or a model that errors mid-journey, is
reported as **`inconclusive`**. Nothing rejected anything; the journey ran out of
road. Folding that into "safely rejected" would let a stalled agent pass for a
correct outcome, which is exactly the flattering accounting this tool exists to
catch. Inconclusive journeys contribute nothing to coverage and are counted on
their own line in every report.

The agent is also told how many tool calls remain once it gets close to the limit.
A reasoning model left to browse freely will happily spend eight calls comparing
hampers and then get cut off mid-purchase — which reads as "the agent gave up"
when really the harness pulled the plug.

---

## The merchant under test

Everything else in the dashboard reports *on* AgentProof. `/hamperhub` shows the
integration itself, because a report about an integration you cannot see is a
report you have to take on trust.

It renders the full catalog with live stock and floor prices, the six tools an AI
buyer is handed with their real descriptions, and the promotions available. Tool
descriptions are written the way a real merchant would write them, ambiguity
included — nothing warns the agent about stacking limits or unpublished allergen
data, because the point is to discover what an agent does when the documentation
is merely adequate.

Most importantly it makes tri-state product data **visible**. A product whose
allergen field was never published is badged `not published`, which is plainly not
the same as `none declared`. That difference is the entire basis of
`INV-PRODUCT-SAFETY`, and on this page you can see it before any test runs.

### Watch a buyer agent shop

`/hamperhub/agent` runs a real journey on demand and shows the agent's tool calls,
the quote it produced, and the Guard's verdict at every lifecycle checkpoint —
then lets you rerun the **identical** buyer request against the other integration.

That side-by-side is the most convincing artefact in the project. Ask for "every
discount I qualify for" and the vulnerable integration produces an 8.7% quote that
the Guard blocks; the fixed one completes. The buyer said exactly the same thing
both times, so nothing about the failure can be blamed on a different input.

Eight curated requests cover the demo narrative: the happy path, discount
stacking, an allergic buyer meeting unpublished data, a retry after a payment
timeout, stock vanishing after approval, a price rising after approval, a buyer
pausing until the quote expires, and a checkout delivered twice.

---

## State perturbation

The suite changes the world while the agent is working, because a defect that only
appears when prices or stock move cannot be found by replaying fixed inputs. All
seven perturbations from the spec are implemented:

| Perturbation | Mechanism |
|---|---|
| Decrease inventory | `MerchantState.setStock` mid-journey |
| Hard stock-out | `forceStockOut` also breaks the reservation |
| Modify a price | `setPrice`, bumping the price version |
| Expire a quote | injected clock advances past the policy window |
| Temporary error | provider times out *after* really creating the order |
| **Delay a response** | latency before a tool, advancing the injected clock |
| **Duplicate a tool response** | the same call delivered twice |
| **Replay an earlier request** | an earlier call re-issued verbatim, later |

The last three act on the *transport* rather than on merchant state, via a wrapper
that sits between the agent and the Guard (`src/lib/runner/perturbation.ts`). The
wrapper can only decide **what** gets called and in what order — every call still
passes through the Guard and is judged by the same invariants, so a perturbation
can reveal a defect but never manufacture one. Duplicates and replays are
invisible to the agent, which is the point: a well-behaved agent should not have
to defend against its transport.

Two real bugs surfaced while building these, both fixed:

- The agent marched past hard blocks — asking for the status of a payment that was
  refused — which buried the real failure under a follow-up error. It now stops on
  a hard refusal, while still retrying a genuine provider timeout, because that
  retry is exactly what `INV-IDEMPOTENCY` exists to contain.
- `approve_quote` minted a second receipt when replayed. Two receipts for one
  quote are individually valid so no invariant fired, yet the spare could later be
  paired with a different checkout. It now converges on the existing receipt.

---

## Concurrency

`npm run demo:concurrency` puts five buyers against three units of coffee, sharing
one merchant state:

```
  ✓ buyer 1  confirmed
  ✓ buyer 2  confirmed
  ✓ buyer 3  confirmed
  •  buyer 4  create_quote: merchant rejected — Cannot reserve stock
  •  buyer 5  create_quote: merchant rejected — Cannot reserve stock

  Orders confirmed: 3     Oversold: no     Duplicate payable orders: 0
  Stock after: available 0, reserved 0     Audit chain: verified
```

Every other scenario runs in an isolated environment, which is right for measuring
detection — a perturbation in one journey must not leak into another — but it means
reservation races are never exercised. Here they are. Losing buyers being turned
away is the correct outcome; the test also fails if *nobody* succeeds, since a
Guard that blocks everyone trivially never oversells and would be useless.

**What this does not prove.** Reservation check-and-hold is synchronous within a
single Node process, so no interleaving can split it. Running two AgentProof
processes against one shared store would need a row lock or a unique constraint to
hold the same guarantee.

---

## Persistence

Optional, and off by default. The engine is deterministic and in-memory; a database
only makes a run survive the process that produced it — which matters when a
reviewer opens a failure the next morning.

```bash
npm run db:up        # local Postgres, or set DATABASE_URL yourself
npm run db:migrate   # idempotent
npm run demo:preflight
npm run db:status
```

A real run, stored:

```
  merchants  1     policies  1        policy_rules      12
  products  17     suites    2        test_scenarios    25
  test_runs 50     violations 30      tool_executions  204
                                      audit_events     653

Persisted hash chains: 50 checked
  ✓ all verify
```

Seventeen tables covering the spec's entities. Money is `BIGINT` paise. A whole
suite is written in one transaction, because a half-written suite is worse than
none — a reader could not tell a missing violation from a passing journey.

`verifyStoredChains` recomputes the hash linkage **from the stored rows**. The
in-memory chain is verified when a run executes, but that proves nothing about what
reached the database, and the database is the copy anyone will actually read.

Configuration accepts a single `DATABASE_URL` or discrete `PGHOST`/`PGUSER`/
`PGPASSWORD`/`PGDATABASE`, since a developer with pgAdmin open has the latter to
hand. A path-like host is treated as a Unix socket. Storage failures never fail a
preflight: it would be absurd for a full disk to turn a clean readiness report into
a failed run.

---

## Honest measurement

Three design decisions exist specifically to keep the numbers meaningful.

**1. Attribution.** Every finding is attributed to `integration`, `agent`, or
`environment`. Only `integration` findings count as merchant defects. The Guard
blocking an agent that overspent the buyer's stated budget is the system working
as intended, not a bug in the merchant's code — so `INV-BUDGET`'s stated-budget
check is attributed to the agent. Without this the false-positive rate would be
inflated by correct behaviour.

The same reasoning applies to product safety: if the merchant published accurate
allergen data and the agent bundled a conflicting item anyway, that is the
agent's error. Only *missing* data — a genuine merchant gap — is charged to the
integration.

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

**4. The narrator may not do arithmetic.** The failure explanation (§16) is the
one place a model writes prose a developer will act on, so every figure is computed
deterministically and passed in; the model may only narrate. It never sees raw
state it could compute from, and its output is never parsed back into a decision.
A mechanical check then rejects any narrative containing a number the facts do not
support — a confidently wrong amount in a financial report is worse than no report,
so a fabricating narrative is withheld and the deterministic account stands alone.

**5. The summary and the detail can never disagree.** The headline count of unsafe
journeys and the itemised violation list are derived from the same data, and a
test asserts they stay in step. A report claiming "0 unsafe violations" beside a
list of defects would destroy trust in every other number on the page.

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

### Running a real test transaction

```bash
# Hosted payment link — gives a URL you can open anywhere. Recommended.
PAYMENT_ADAPTER=razorpay npm run demo:razorpay -- --link --wait=180

# Bare Orders API — writes a local page that runs Razorpay's browser SDK.
PAYMENT_ADAPTER=razorpay npm run demo:razorpay -- --wait=180
```

The agent drives the journey, the Guard authorises, and only then is a payable
artefact created. The script proves `INV-PAYMENT-STATE` by deliberately
attempting fulfilment before capture and being blocked, then polls until the
payment is captured and **verified against Razorpay** before fulfilling.

Two collection modes exist because Razorpay Checkout needs its browser SDK, which
a CLI cannot drive. `--link` creates a hosted payment link — a URL anyone can
open — and is the only option if you cannot reach the filesystem. Either way the
artefact is created solely after a passing verdict, and carries the Guard's
idempotency key (`receipt` for orders, `reference_id` for links).

Without credentials the script explains what to configure and exits zero, so it is
safe in CI.

**This has been run end to end against Razorpay test mode.** A verified transcript:

```
Guard authorised the checkout. Razorpay test payment link created:
  link id:   plink_TUskFj744r1ZLS
  amount:    ₹1,399.00 INR
  receipt:   idem_d70febc62a927b99d6009cc8

Fulfilment attempted before capture (deliberate probe):
  BLOCKED — Merchant declined fulfilment: payment is 'created' (verified=false)

Polling Razorpay for up to 180s...
  status: captured (verified=true)

Payment captured and verified against Razorpay.
Merchant order confirmed. Inventory committed: coffee 7.

✓ Real Razorpay test transaction complete: ₹1,399.00 captured and verified.
  Guard verdicts: 1 expected (the pre-capture probe), 0 unexpected.
```

Read back from Razorpay's API, the payment was `139900` paise — exactly the amount
the buyer approved — captured via netbanking, against a link carrying our
idempotency key as its `reference_id`.

### Idempotency, confirmed by the platform

Attempting to reuse a `reference_id` gets rejected by Razorpay outright:

> payment link with given reference_id: … already exists

That is the platform's *only* duplicate defence, and it only helps if the
integration derives a stable reference and reconciles on retry rather than
minting a fresh one. The adapter therefore looks up an existing link before
creating, so a retry converges on the same payable artefact instead of erroring
— or worse, quietly opening a second one. This is `INV-IDEMPOTENCY`'s argument,
validated against the real API.

Live keys are refused before any request is made.

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
src/lib/agent/                  LLM adapters (scripted, OpenAI, Anthropic) + agent
src/lib/payments/               Provider interface, Razorpay adapter, fake
src/lib/scenarios/              Regression, perturbation, live-agent and generated
src/lib/runner/                 Journey execution, perturbation, concurrency
src/lib/report/                 Readiness report, metrics, trace replay, explanation
src/lib/db/                     Postgres schema, repository and queries
src/lib/dashboard/              Server-side data layer for the dashboard
src/lib/dashboard/runStore.ts   Completed runs; in memory, mirrored to Postgres
src/app/preflight/              Trigger a run and stream it (SSE)
src/app/api/preflight/          Suite runner as a server-sent event stream
src/app/                        Next.js dashboard (server components elsewhere)
src/scripts/                    Runnable demos and database tooling
scripts/dev-db.sh               Local Postgres for development
tests/                          335 tests
```

Money is an integer count of paise throughout. Float rupees are banned: an
invariant that compares `1399.0000000000002 <= 1399` is worse than no invariant.

Time is injected everywhere, so quote expiry is a test input rather than a race
condition, and every run is reproducible from a seed.

---

## Limitations

Honest scope. What is built is listed above; these are the real gaps:

- **Razorpay is verified in test mode only, on one account.** A full capture has
  been observed end to end, but only via netbanking on a fresh test account.
  Card payments were rejected there as international, which is an account
  configuration rather than an integration problem — worth knowing if you
  reproduce it.
- **The real-LLM path works but the numbers in this README come from the scripted
  model.** Live runs against a real reasoning model have been verified end to end,
  including a real Razorpay capture, but the measured table above is the
  deterministic suite. Live-agent journeys are labelled as such in every report
  precisely so the two are never conflated.
- **Live-agent recall is not a stable measurement.** A live journey where the model
  never reached checkout tells you nothing about the invariant it targeted; that is
  why those runs are reported as `inconclusive` and why the deterministic suite
  still exists alongside them.
- **Two models is two, not a survey.** The per-model comparison shows that model
  choice changes what an agent does to your checkout. It does not establish which
  model is "safer" — that would need many runs per model, since a single live
  journey is one sample from a distribution.
- **Concurrency is single-process.** Interleaved journeys are exercised and cannot
  oversell, but reservation check-and-hold is synchronous within one Node process.
  A multi-process deployment would need a row lock or unique constraint.
- **One merchant, one policy.** HamperHub is the only integration under test, so
  the Guard's independence from a specific commerce backend is a design property
  rather than a demonstrated one.
- **Persistence is write-and-read-back, not yet a query surface.** Runs are stored
  and verified, and the read queries exist, but the dashboard reads its in-process
  cache. Restarting the server loses the run list even though the rows survive in
  Postgres.
- **Testing cannot prove absence of defects.** Eight seeded defects are detected;
  that is evidence the invariants work, not a guarantee the space is covered.
  Hence "readiness report", and hence the Guard stays active at runtime.

## Configuration

Copy `.env.example` to `.env`. Defaults run fully offline and deterministically.

```
PAYMENT_ADAPTER=fake        # or "razorpay" with rzp_test_ credentials
RAZORPAY_KEY_ID=            # must start with rzp_test_
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=    # optional; only useful on a public URL

LLM_ADAPTER=scripted        # scripted | openai | anthropic
LLM_API_KEY=                # required for openai; anthropic falls back to it
LLM_MODEL=                  # defaults to gpt-4o-mini
LLM_BASE_URL=               # any OpenAI-compatible endpoint

ANTHROPIC_MODEL=            # naming a deployment adds it to the driver pool
ANTHROPIC_API_KEY=          # optional; falls back to LLM_API_KEY
ANTHROPIC_BASE_URL=         # Messages API host, e.g. an Azure AI Foundry endpoint

AGENTPROOF_SEED=1337        # reproducible demo runs

DATABASE_URL=               # optional; or PGHOST/PGUSER/PGPASSWORD/PGDATABASE
```

Every default keeps the project offline and deterministic. The real adapters are
strictly opt-in, and the suite must pass without them.

---

Traditional checkout tests whether the code works. AgentProof tests what an AI
buyer might actually do — and stops money from moving when it should not.
