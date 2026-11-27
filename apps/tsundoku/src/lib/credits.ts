/**
 * Credit metering & billing for the AI features.
 *
 * AI access is funded by a USD-denominated credit balance rather than a
 * one-time boolean unlock: a $0.99 HitPay top-up adds credit, and every AI
 * action deducts its configured per-action rate. The balance is always derived
 * from the append-only `credit_ledger` table, so "credit added", "credit used",
 * and "credit remaining" are auditable sums instead of guessed counters.
 *
 * `credit_ledger.amount` is signed — top-ups positive, usage negative — so the
 * remaining balance is simply `SUM(amount)`.
 *
 * Every function takes the `D1Database` binding so the helpers stay a pure
 * function of the current request's environment.
 */

/** Ledger `kind` values. */
export const CREDIT_KIND_TOPUP = "topup";
export const CREDIT_KIND_USAGE = "usage";

/** Ledger `action` values. */
export const CREDIT_ACTION_HITPAY_TOPUP = "hitpay_topup";
export const CREDIT_ACTION_BOOK_SUMMARY = "book_summary";
export const CREDIT_ACTION_BATCH_BOOK_SUMMARY = "batch_book_summary";
export const CREDIT_ACTION_BOOK_TITLE_IMAGE = "book_title_image";

/** The AI actions that deduct credit (a subset of the ledger actions). */
export type CreditUsageAction =
  | typeof CREDIT_ACTION_BOOK_SUMMARY
  | typeof CREDIT_ACTION_BATCH_BOOK_SUMMARY
  | typeof CREDIT_ACTION_BOOK_TITLE_IMAGE;

/** Human labels for the settings "Billing & Metering" breakdown. */
export const CREDIT_ACTION_LABELS: Record<string, string> = {
  [CREDIT_ACTION_HITPAY_TOPUP]: "Credit top-up",
  [CREDIT_ACTION_BOOK_SUMMARY]: "Book summary",
  [CREDIT_ACTION_BATCH_BOOK_SUMMARY]: "Batch book summary",
  [CREDIT_ACTION_BOOK_TITLE_IMAGE]: "Book title / cover image",
};

/** Default per-action USD rates used when the binding is unset or invalid. */
export const DEFAULT_CREDIT_RATES = {
  /** Per single book summary (`CREDIT_RATE_BOOK_SUMMARY`). */
  bookSummary: 0.00001,
  /** Per book within a batch summary run (`CREDIT_RATE_BATCH_BOOK_SUMMARY`). */
  batchBookSummary: 0.0001,
  /** Per book title / cover image extraction (`CREDIT_RATE_BOOK_TITLE_IMAGE`). */
  bookTitleImage: 0.00005,
} as const;

/** The subset of `Cloudflare.Env` the rate resolver reads. */
export interface CreditRateBindings {
  CREDIT_RATE_BOOK_SUMMARY?: string;
  CREDIT_RATE_BATCH_BOOK_SUMMARY?: string;
  CREDIT_RATE_BOOK_TITLE_IMAGE?: string;
}

/** Resolved per-action USD rates. */
export interface CreditRates {
  bookSummary: number;
  batchBookSummary: number;
  bookTitleImage: number;
}

/** Parse a binding into a non-negative rate, falling back when unusable. */
function parseRate(value: string | undefined, fallback: number): number {
  // A blank binding means "unset" (not an explicit 0), so fall back rather than
  // silently charging nothing.
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Resolve the per-action credit rates from Worker bindings, applying the
 * documented defaults when a binding is absent, blank, or not a valid
 * non-negative number.
 */
export function resolveCreditRates(
  bindings: CreditRateBindings = {},
): CreditRates {
  return {
    bookSummary: parseRate(
      bindings.CREDIT_RATE_BOOK_SUMMARY,
      DEFAULT_CREDIT_RATES.bookSummary,
    ),
    batchBookSummary: parseRate(
      bindings.CREDIT_RATE_BATCH_BOOK_SUMMARY,
      DEFAULT_CREDIT_RATES.batchBookSummary,
    ),
    bookTitleImage: parseRate(
      bindings.CREDIT_RATE_BOOK_TITLE_IMAGE,
      DEFAULT_CREDIT_RATES.bookTitleImage,
    ),
  };
}

/** The USD rate charged for a given AI usage action. */
export function rateForAction(
  rates: CreditRates,
  action: CreditUsageAction,
): number {
  switch (action) {
    case CREDIT_ACTION_BOOK_SUMMARY:
      return rates.bookSummary;
    case CREDIT_ACTION_BATCH_BOOK_SUMMARY:
      return rates.batchBookSummary;
    case CREDIT_ACTION_BOOK_TITLE_IMAGE:
      return rates.bookTitleImage;
  }
}

/** Round to micro-dollar precision so float sums stay readable. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Format a USD credit amount for display: at least two decimals, more when the
 * value needs them, with trailing zeros trimmed (e.g. `0.99`, `0.00001`).
 */
export function formatCredit(value: number): string {
  if (!Number.isFinite(value)) return "0.00";
  const trimmed = value.toFixed(5).replace(/0+$/, "").replace(/\.$/, "");
  const [whole, fraction = ""] = trimmed.split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

interface CreditSumRow {
  total: number | null;
}

/** Remaining USD credit for a user (the signed sum of their ledger). */
export async function getCreditBalance(
  db: D1Database,
  userId: string,
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM credit_ledger WHERE user_id = ?",
    )
    .bind(userId)
    .first<CreditSumRow>();
  return round6(row?.total ?? 0);
}

/** Aggregated, auditable billing numbers for the settings UI. */
export interface CreditSummary {
  /** Current remaining balance (`totalAdded - totalUsed`). */
  balance: number;
  /** Lifetime credit added through top-ups. */
  totalAdded: number;
  /** Lifetime credit consumed by AI usage. */
  totalUsed: number;
  /** Usage totals grouped by action, largest first. */
  usageByAction: Array<{ action: string; label: string; total: number }>;
}

/** Read every billing figure for a user in two aggregate queries. */
export async function getCreditSummary(
  db: D1Database,
  userId: string,
): Promise<CreditSummary> {
  const totals = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN kind = 'topup' THEN amount ELSE 0 END), 0) AS added,
         COALESCE(SUM(CASE WHEN kind = 'usage' THEN -amount ELSE 0 END), 0) AS used
       FROM credit_ledger
      WHERE user_id = ?`,
    )
    .bind(userId)
    .first<{ added: number | null; used: number | null }>();

  const usage = await db
    .prepare(
      `SELECT action, COALESCE(SUM(-amount), 0) AS total
         FROM credit_ledger
        WHERE user_id = ? AND kind = 'usage'
        GROUP BY action
        ORDER BY total DESC`,
    )
    .bind(userId)
    .all<{ action: string; total: number | null }>();

  const rows = usage?.results ?? [];
  return {
    balance: round6((totals?.added ?? 0) - (totals?.used ?? 0)),
    totalAdded: round6(totals?.added ?? 0),
    totalUsed: round6(totals?.used ?? 0),
    usageByAction: rows.map((row) => ({
      action: row.action,
      label: CREDIT_ACTION_LABELS[row.action] ?? row.action,
      total: round6(row.total ?? 0),
    })),
  };
}

export interface AddCreditInput {
  /** Positive USD amount to add. */
  amount: number;
  /** Ledger action; defaults to a HitPay top-up. */
  action?: string;
  /** Idempotency key; a replayed reference is ignored rather than double-credited. */
  reference?: string | null;
}

export interface AddCreditResult {
  /** Whether a new ledger row was written (`false` on a replayed reference). */
  credited: boolean;
  /** Remaining balance after the insert. */
  balance: number;
}

/**
 * Add credit for a user. When `reference` is supplied it acts as an idempotency
 * key (backed by a unique index), so a replayed HitPay webhook or a return-time
 * reconcile can never credit the same payment twice. Returns the resulting
 * balance and whether this call actually moved it.
 */
export async function addCredit(
  db: D1Database,
  userId: string,
  input: AddCreditInput,
): Promise<AddCreditResult> {
  const amount = round6(Math.abs(input.amount));
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO credit_ledger (id, user_id, kind, action, amount, reference, created_at)
       VALUES (?, ?, 'topup', ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      userId,
      input.action ?? CREDIT_ACTION_HITPAY_TOPUP,
      amount,
      input.reference ?? null,
      new Date().toISOString(),
    )
    .run();

  const credited = (result.meta?.changes ?? 0) > 0;
  return { credited, balance: await getCreditBalance(db, userId) };
}

export interface RecordUsageInput {
  action: CreditUsageAction;
  /** Positive USD rate charged for this usage. */
  amount: number;
  /** Optional external key (e.g. per-run id) to keep usage events distinguishable. */
  reference?: string | null;
}

/**
 * Record an AI usage event as a negative ledger entry so the balance and the
 * per-action billing totals stay auditable. Returns the remaining balance.
 */
export async function recordUsage(
  db: D1Database,
  userId: string,
  input: RecordUsageInput,
): Promise<number> {
  const amount = round6(Math.abs(input.amount));
  // A zero/negative configured rate charges nothing, so there is no usage event
  // to record — return the (unchanged) balance rather than writing a no-op row.
  if (amount <= 0) return getCreditBalance(db, userId);
  await db
    .prepare(
      `INSERT INTO credit_ledger (id, user_id, kind, action, amount, reference, created_at)
       VALUES (?, ?, 'usage', ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      userId,
      input.action,
      -amount,
      input.reference ?? null,
      new Date().toISOString(),
    )
    .run();
  return getCreditBalance(db, userId);
}

/** A persisted HitPay payment request tied to a user's credit top-up. */
export interface CreditPayment {
  /** HitPay payment request id (used for the status lookup). */
  id: string;
  userId: string;
  /** HitPay `reference_number` (unique per payment; the ledger idempotency key). */
  reference: string;
  /** Charged amount in the currency's major unit (e.g. `0.99`). */
  amount: number;
  currency: string;
  /** `pending` | `completed` | `failed` | `expired` | `canceled` | `inactive`. */
  status: string;
  /** When the top-up was credited to the ledger, or `null` while uncredited. */
  creditedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CreditPaymentRow {
  id: string;
  user_id: string;
  reference: string;
  amount: number;
  currency: string;
  status: string;
  credited_at: string | null;
  created_at: string;
  updated_at: string;
}

const PAYMENT_COLUMNS =
  "id, user_id, reference, amount, currency, status, credited_at, created_at, updated_at";

function mapPaymentRow(row: CreditPaymentRow): CreditPayment {
  return {
    id: row.id,
    userId: row.user_id,
    reference: row.reference,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    creditedAt: row.credited_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface RecordPaymentInput {
  /** HitPay payment request id. */
  id: string;
  userId: string;
  reference: string;
  amount: number;
  currency: string;
}

/**
 * Persist a `pending` payment row at checkout so a return from HitPay can
 * reconcile the payment's real status even when the deprecated per-request
 * webhook is never delivered. Keyed by the HitPay payment id and guarded by a
 * unique `reference` index, so a retried checkout can never duplicate a row.
 */
export async function recordPendingPayment(
  db: D1Database,
  input: RecordPaymentInput,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT OR IGNORE INTO credit_payments
         (id, user_id, reference, amount, currency, status, credited_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
    )
    .bind(
      input.id,
      input.userId,
      input.reference,
      input.amount,
      input.currency,
      now,
      now,
    )
    .run();
}

/** Look up a payment row by its HitPay `reference_number`, or `null`. */
export async function getPaymentByReference(
  db: D1Database,
  reference: string,
): Promise<CreditPayment | null> {
  const row = await db
    .prepare(
      `SELECT ${PAYMENT_COLUMNS} FROM credit_payments WHERE reference = ? LIMIT 1`,
    )
    .bind(reference)
    .first<CreditPaymentRow>();
  return row ? mapPaymentRow(row) : null;
}

/**
 * Update a payment's status (and, when crediting, stamp `credited_at`). The
 * `COALESCE` keeps a previously-recorded `credited_at` so a later reconcile
 * cannot erase the credit timestamp.
 */
export async function markPaymentStatus(
  db: D1Database,
  id: string,
  status: string,
  creditedAt: string | null = null,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE credit_payments
          SET status = ?, credited_at = COALESCE(?, credited_at), updated_at = ?
        WHERE id = ?`,
    )
    .bind(status, creditedAt, now, id)
    .run();
}
