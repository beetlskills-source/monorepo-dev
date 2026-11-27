-- Phase 10: credit metering & billing for the AI features.
--
-- Replaces the one-time boolean `shelf_configs.has_llm_unlock` gate with a
-- USD-denominated credit balance: a $0.99 HitPay top-up adds credit and every
-- AI action deducts its configured per-action rate. The balance is always
-- derived from the append-only `credit_ledger`, so "credit added", "credit
-- used", and "credit remaining" are auditable sums instead of guessed counters.
--
-- `credit_ledger.amount` is signed: top-ups are positive, usage is negative, so
-- `SUM(amount)` is the remaining balance in USD.

CREATE TABLE IF NOT EXISTS "credit_ledger" (
  "id" TEXT PRIMARY KEY,
  "user_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,            -- 'topup' | 'usage'
  "action" TEXT NOT NULL,          -- 'hitpay_topup' | 'book_summary' | 'batch_book_summary' | 'book_title_image'
  "amount" REAL NOT NULL,          -- signed USD: + top-up, - usage
  "reference" TEXT,                -- external idempotency key (HitPay reference_number)
  "created_at" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_credit_ledger_user"
  ON "credit_ledger" ("user_id", "created_at");

-- A non-null reference is unique so a replayed webhook or a return-time
-- reconcile can never credit the same payment twice. SQLite allows many NULLs.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_credit_ledger_reference"
  ON "credit_ledger" ("reference");

-- One row per HitPay payment request. Persisted at checkout so a return from
-- HitPay can reconcile the payment's real status even when the deprecated
-- per-request webhook is never delivered.
CREATE TABLE IF NOT EXISTS "credit_payments" (
  "id" TEXT PRIMARY KEY,           -- HitPay payment request id
  "user_id" TEXT NOT NULL,
  "reference" TEXT NOT NULL,       -- HitPay reference_number (unique per payment)
  "amount" REAL NOT NULL,
  "currency" TEXT NOT NULL,
  "status" TEXT NOT NULL,          -- pending | completed | failed | expired | canceled | inactive
  "credited_at" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_credit_payments_user"
  ON "credit_payments" ("user_id", "created_at");

CREATE UNIQUE INDEX IF NOT EXISTS "idx_credit_payments_reference"
  ON "credit_payments" ("reference");

-- Backfill: users who already hold the legacy boolean unlock keep access by
-- receiving a one-time credit top-up equal to the unlock price. The
-- deterministic id/reference makes this idempotent and auditable.
INSERT OR IGNORE INTO "credit_ledger" ("id", "user_id", "kind", "action", "amount", "reference", "created_at")
SELECT 'legacy-llmunlock-' || user_id,
       user_id,
       'topup',
       'hitpay_topup',
       0.99,
       'legacy-llmunlock:' || user_id,
       COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  FROM "shelf_configs"
 WHERE has_llm_unlock = 1;
