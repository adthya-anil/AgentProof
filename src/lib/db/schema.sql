-- AgentProof persistence schema.
--
-- Models the core entities from the spec so a preflight run survives the process
-- that produced it: a judge or developer can come back tomorrow and replay a
-- failure without re-running anything.
--
-- Conventions:
--   * money is BIGINT paise, never floating point;
--   * provider/domain identifiers are TEXT because they come from Razorpay or
--     from our own seeded id factory, not from a sequence;
--   * payloads that exist for human inspection are JSONB;
--   * ON DELETE CASCADE throughout, so dropping a suite removes its whole tree.

CREATE TABLE IF NOT EXISTS merchants (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  currency      TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS policies (
  -- Content-addressed version, e.g. hamperhub-v1@01fd5ae8791f.
  version       TEXT PRIMARY KEY,
  policy_id     TEXT NOT NULL,
  merchant_id   TEXT REFERENCES merchants(id) ON DELETE CASCADE,
  currency      TEXT NOT NULL,
  -- The approved structured document. This, not any prompt, is what was enforced.
  document      JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS policy_rules (
  id             TEXT NOT NULL,
  policy_version TEXT NOT NULL REFERENCES policies(version) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  severity       TEXT NOT NULL,
  attribution    TEXT NOT NULL,
  policy_refs    TEXT[] NOT NULL DEFAULT '{}',
  checkpoints    TEXT[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (policy_version, id)
);

CREATE TABLE IF NOT EXISTS commerce_tools (
  name          TEXT NOT NULL,
  merchant_id   TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  description   TEXT NOT NULL,
  parameters    JSONB NOT NULL,
  PRIMARY KEY (merchant_id, name)
);

CREATE TABLE IF NOT EXISTS products (
  id                TEXT NOT NULL,
  merchant_id       TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  category          TEXT NOT NULL,
  price_minor       BIGINT NOT NULL,
  price_version     INTEGER NOT NULL,
  -- NULL means the merchant supplied no data. Distinct from '{}' (verified
  -- allergen-free); collapsing the two is a seeded defect.
  allergens         TEXT[],
  vegan             BOOLEAN,
  bundle_eligible   BOOLEAN NOT NULL,
  min_price_minor   BIGINT NOT NULL,
  PRIMARY KEY (merchant_id, id)
);

CREATE TABLE IF NOT EXISTS inventory_records (
  product_id    TEXT NOT NULL,
  merchant_id   TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  available     INTEGER NOT NULL,
  reserved      INTEGER NOT NULL,
  version       INTEGER NOT NULL,
  PRIMARY KEY (merchant_id, product_id)
);

CREATE TABLE IF NOT EXISTS test_scenarios (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  category           TEXT NOT NULL,
  source             TEXT NOT NULL,          -- 'regression' | 'generated'
  targets_invariant  TEXT,
  utterance          TEXT NOT NULL,
  constraints        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A whole preflight execution: one suite, many journeys.
CREATE TABLE IF NOT EXISTS suites (
  id                    UUID PRIMARY KEY,
  label                 TEXT NOT NULL,
  policy_version        TEXT REFERENCES policies(version) ON DELETE SET NULL,
  merchant_id           TEXT REFERENCES merchants(id) ON DELETE SET NULL,
  mutations             TEXT[] NOT NULL DEFAULT '{}',
  integration_variant   TEXT NOT NULL,
  generator_model       TEXT,
  generator_is_real     BOOLEAN NOT NULL DEFAULT false,
  payment_adapter       TEXT,
  passed                INTEGER NOT NULL,
  safely_rejected       INTEGER NOT NULL,
  escalated             INTEGER NOT NULL,
  unsafe_violations     INTEGER NOT NULL,
  -- Live-agent journeys that ended without anything deciding them. Kept out of
  -- the counts above on purpose: they verified nothing.
  inconclusive          INTEGER NOT NULL DEFAULT 0,
  errored               INTEGER NOT NULL,
  money_critical_escapes INTEGER NOT NULL,
  money_at_risk_minor   BIGINT NOT NULL,
  audit_chain_ok        BOOLEAN NOT NULL,
  readiness             TEXT NOT NULL,
  duration_ms           INTEGER NOT NULL,
  -- §17 metrics that are derived rather than counted.
  metrics               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One journey. The spec's TestRun.
CREATE TABLE IF NOT EXISTS test_runs (
  id                       UUID PRIMARY KEY,
  suite_id                 UUID NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
  scenario_id              TEXT NOT NULL,
  run_label                TEXT NOT NULL,
  intent_id                TEXT,
  title                    TEXT NOT NULL,
  category                 TEXT NOT NULL,
  -- 'deterministic' for a fixed tool sequence, 'agent' for a live model.
  driver                   TEXT NOT NULL DEFAULT 'deterministic',
  -- Which model drove it; NULL when a fixed sequence did. Stored per journey
  -- because one suite can deal journeys across several model families, and a
  -- finding is only actionable if you know which agent produced it.
  model                    TEXT,
  targets_invariant        TEXT,
  disposition              TEXT NOT NULL,
  note                     TEXT NOT NULL,
  fired_invariants         TEXT[] NOT NULL DEFAULT '{}',
  money_at_risk_minor      BIGINT NOT NULL,
  provider_orders          INTEGER NOT NULL,
  duplicate_payable_orders INTEGER NOT NULL,
  self_rejected            BOOLEAN NOT NULL,
  audit_events             INTEGER NOT NULL,
  audit_chain_ok           BOOLEAN NOT NULL,
  duration_ms              INTEGER NOT NULL,
  ms_to_first_violation    INTEGER,
  error                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS test_runs_suite_idx ON test_runs (suite_id);
CREATE INDEX IF NOT EXISTS test_runs_disposition_idx ON test_runs (disposition);

CREATE TABLE IF NOT EXISTS tool_executions (
  id            BIGSERIAL PRIMARY KEY,
  test_run_id   UUID NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  tool_name     TEXT NOT NULL,
  arguments     JSONB NOT NULL DEFAULT '{}'::jsonb,
  ok            BOOLEAN NOT NULL,
  summary       TEXT NOT NULL,
  UNIQUE (test_run_id, seq)
);

CREATE TABLE IF NOT EXISTS violations (
  id               TEXT NOT NULL,
  test_run_id      UUID NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  invariant_id     TEXT NOT NULL,
  title            TEXT NOT NULL,
  severity         TEXT NOT NULL,
  attribution      TEXT NOT NULL,
  kind             TEXT NOT NULL,   -- 'violation' | 'escalation'
  checkpoint       TEXT NOT NULL,
  policy_refs      TEXT[] NOT NULL DEFAULT '{}',
  message          TEXT NOT NULL,
  observed         JSONB NOT NULL DEFAULT '{}'::jsonb,
  expected         JSONB NOT NULL DEFAULT '{}'::jsonb,
  money_at_risk_minor BIGINT NOT NULL,
  remediation      TEXT,
  quote_id         TEXT,
  occurred_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (test_run_id, id, checkpoint)
);

CREATE INDEX IF NOT EXISTS violations_invariant_idx ON violations (invariant_id);

-- Append-only, hash-chained. Never updated.
CREATE TABLE IF NOT EXISTS audit_events (
  id                BIGSERIAL PRIMARY KEY,
  test_run_id       UUID NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  occurred_at       TIMESTAMPTZ NOT NULL,
  type              TEXT NOT NULL,
  run_label         TEXT NOT NULL,
  intent_id         TEXT,
  tool_name         TEXT,
  input             JSONB,
  output            JSONB,
  policy_version    TEXT,
  decision          TEXT,
  reason            TEXT,
  quote_id          TEXT,
  provider_order_id TEXT,
  violation_ids     TEXT[] NOT NULL DEFAULT '{}',
  prev_hash         TEXT NOT NULL,
  hash              TEXT NOT NULL,
  UNIQUE (test_run_id, seq)
);

CREATE INDEX IF NOT EXISTS audit_events_run_seq_idx ON audit_events (test_run_id, seq);

CREATE TABLE IF NOT EXISTS quotes (
  id                  TEXT NOT NULL,
  test_run_id         UUID NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  version             INTEGER NOT NULL,
  intent_id           TEXT NOT NULL,
  currency            TEXT NOT NULL,
  line_items          JSONB NOT NULL,
  subtotal_minor      BIGINT NOT NULL,
  discounts           JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_discount_minor BIGINT NOT NULL,
  total_minor         BIGINT NOT NULL,
  policy_version      TEXT NOT NULL,
  reservation_id      TEXT,
  status              TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (test_run_id, id)
);

CREATE TABLE IF NOT EXISTS approval_receipts (
  id                    TEXT NOT NULL,
  test_run_id           UUID NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  quote_id              TEXT NOT NULL,
  quote_version         INTEGER NOT NULL,
  intent_id             TEXT NOT NULL,
  approved_amount_minor BIGINT NOT NULL,
  currency              TEXT NOT NULL,
  confirmation_text     TEXT NOT NULL,
  approved_content_hash TEXT NOT NULL,
  policy_version        TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (test_run_id, id)
);

CREATE TABLE IF NOT EXISTS checkout_intents (
  id                   TEXT NOT NULL,
  test_run_id          UUID NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  intent_id            TEXT NOT NULL,
  quote_id             TEXT NOT NULL,
  quote_version        INTEGER NOT NULL,
  approval_receipt_id  TEXT,
  -- One payable order per key. The spec's CheckoutIntent -> one idempotency key.
  idempotency_key      TEXT NOT NULL,
  amount_minor         BIGINT NOT NULL,
  currency             TEXT NOT NULL,
  status               TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (test_run_id, id)
);

CREATE INDEX IF NOT EXISTS checkout_intents_idem_idx
  ON checkout_intents (test_run_id, idempotency_key);

CREATE TABLE IF NOT EXISTS payment_attempts (
  id                  TEXT NOT NULL,
  test_run_id         UUID NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  checkout_intent_id  TEXT NOT NULL,
  provider_order_id   TEXT NOT NULL,
  provider_payment_id TEXT,
  amount_minor        BIGINT NOT NULL,
  currency            TEXT NOT NULL,
  status              TEXT NOT NULL,
  verified            BOOLEAN NOT NULL,
  hosted_url          TEXT,
  created_at          TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (test_run_id, id)
);

CREATE TABLE IF NOT EXISTS orders (
  id                  TEXT NOT NULL,
  test_run_id         UUID NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  checkout_intent_id  TEXT NOT NULL,
  payment_attempt_id  TEXT NOT NULL,
  amount_minor        BIGINT NOT NULL,
  currency            TEXT NOT NULL,
  status              TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (test_run_id, id)
);


-- ---------------------------------------------------------------------------
-- Additive migrations
-- ---------------------------------------------------------------------------
--
-- `migrate()` replays this whole file on every startup, so everything above is
-- written with IF NOT EXISTS. That creates a trap: a table added earlier is left
-- untouched, so a column added to a CREATE TABLE above never reaches a database
-- that already exists. The first symptom would be an insert failing on a live
-- deployment while a fresh one works perfectly.
--
-- New columns therefore go here as well, as idempotent ALTERs.

ALTER TABLE test_runs
  ADD COLUMN IF NOT EXISTS driver TEXT NOT NULL DEFAULT 'deterministic';
ALTER TABLE test_runs
  ADD COLUMN IF NOT EXISTS model TEXT;

ALTER TABLE suites
  ADD COLUMN IF NOT EXISTS inconclusive INTEGER NOT NULL DEFAULT 0;

-- Answering "which model tripped this invariant" is the point of running more
-- than one, so it should not require a sequential scan.
CREATE INDEX IF NOT EXISTS test_runs_model_idx ON test_runs (model);


-- ---------------------------------------------------------------------------
-- Replay snapshot
-- ---------------------------------------------------------------------------
--
-- The normalised tables above are the *analytical* surface: they exist so you can
-- ask questions across runs in SQL — which model tripped which invariant, how
-- recall moved between policy versions, whether every stored hash chain still
-- verifies.
--
-- They are deliberately not a lossless copy. Eight fields of a JourneyResult have
-- no column, because they are replay detail rather than things worth querying:
-- exercised invariants, tool paths, per-journey perturbation records, and so on.
-- Reconstructing a dashboard from the tables alone would therefore render a report
-- subtly poorer than the one that was produced, with empty tool paths and missing
-- escalations, and a reader would have no way to know which absences were real.
--
-- So a run also stores an exact snapshot. Two surfaces, two jobs: query the tables,
-- replay the snapshot. Adding columns for the missing eight would bloat the schema
-- with fields nobody would ever filter on, and would still drift the moment
-- JourneyResult gained a field.
ALTER TABLE suites ADD COLUMN IF NOT EXISTS result JSONB;


-- ---------------------------------------------------------------------------
-- Money-critical uniqueness
-- ---------------------------------------------------------------------------
--
-- One payable order per buyer intent, enforced by the database rather than checked by
-- the application.
--
-- INV-IDEMPOTENCY already detects a second payable order, and detection is the wrong
-- guarantee for money: it means the second order existed long enough to be noticed. A
-- unique index means the second INSERT fails. Two processes racing cannot both win,
-- whatever either believes about the other, and no amount of lock-management bugs can
-- widen the window because there is no window.
--
-- Partial, because a blocked or failed checkout intent is not payable and several of
-- those per intent are entirely normal — a run that gets blocked at checkout, has its
-- quote re-priced, and tries again produces exactly that.
--
-- The invariant stays. It now reports on a rule the storage layer already enforces,
-- which is the right relationship between the two: the constraint prevents, the
-- invariant explains.
CREATE UNIQUE INDEX IF NOT EXISTS one_payable_order_per_intent
    ON checkout_intents (test_run_id, intent_id)
 WHERE status IN ('authorized', 'fulfilled');

-- Scoped by test_run_id, and that scoping is not incidental. Intent ids come from a
-- seeded IdFactory, so a preflight that persists a vulnerable suite and then a fixed
-- one can mint the same intent id in both. An index on intent_id alone would reject the
-- second, legitimate run — and because both persistSuite call sites swallow their
-- errors, the whole suite would roll back in silence. Correct-looking constraint,
-- invisible data loss.
--
-- Note what this index does and does not do. checkout_intents is written when a run
-- finishes, so a constraint here audits recorded evidence; it cannot prevent a charge
-- that already happened. Prevention lives in payable_order_claims below, which is
-- written on the authorization path itself.


-- ---------------------------------------------------------------------------
-- Live payable-order claims
-- ---------------------------------------------------------------------------
--
-- The claim that actually stops a double charge, taken before the provider order is
-- created rather than recorded after.
--
-- The merchant's own defence is an in-memory scan of its payment map, which is correct
-- for exactly one process; a second process has its own map, sees nothing, and both
-- create an order. Whoever inserts here owns the sole payable order for that intent,
-- and everyone else is told who owns it. Two processes racing cannot both win.
--
-- Not scoped to a test run, because the point is to be visible to processes that share
-- nothing but this database. Scoped instead by a deployment nonce inside claim_key,
-- so independent runs cannot collide while a single deployment stays global.
CREATE TABLE IF NOT EXISTS payable_order_claims (
  claim_key   TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  claimed_at  TIMESTAMPTZ NOT NULL
);
