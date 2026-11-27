/**
 * D1 accessors for the `shelf_configs` table (Phase 2). Each user owns exactly
 * one row keyed by `user_id`. Every function takes the `D1Database` binding so
 * the helpers stay a pure function of the current request's environment.
 */

export type DefaultVisibility = "private" | "shared";

/**
 * Level 2 of the visibility model: whether the user's *whole* Google Sheet is
 * published to co-members. Deliberately separate from {@link DefaultVisibility}
 * ("Default visibility for new books") so changing the new-book default never
 * hides or exposes a shelf on other members' dashboards (Phase 6).
 */
export type SheetVisibility = "private" | "shared";

/** Default sheet tab when a user has not chosen one. */
export const DEFAULT_SHEET_TAB_NAME = "Books";

export interface ShelfConfig {
  userId: string;
  /** Bound/created Google spreadsheet id, or `null` before setup. */
  spreadsheetId: string | null;
  sheetTabName: string;
  /** Starting `visibility` for newly scanned books only (see Phase 6). */
  defaultVisibility: DefaultVisibility;
  /** Whether the whole sheet appears to co-members' Shared Shelves (Level 2). */
  sheetVisibility: SheetVisibility;
  allowIncomingTransfers: boolean;
  /**
   * Whether an ISBN scan should also run the best-effort Featherless AI
   * enrichment step ("Enrich book info with LLM" on the ISBN Scanner). Defaults
   * to `false` (off), so an unset preference never waits on the LLM.
   */
  enrichWithLlm: boolean;
  /**
   * Whether the user has the one-time $0.99 "LLM unlock" entitlement, gating
   * both AI features (LLM summaries and vision cover reading). Defaults to
   * `false`, so every user starts on the free tier. Deliberately distinct from
   * {@link enrichWithLlm}, which is only a preference.
   */
  hasLlmUnlock: boolean;
  /** True when an encrypted Google refresh token is stored. */
  hasRefreshToken: boolean;
  updatedAt: string;
}

/** Fields that may be written; all optional so callers patch incrementally. */
export interface ShelfConfigPatch {
  spreadsheetId?: string | null;
  sheetTabName?: string;
  defaultVisibility?: DefaultVisibility;
  sheetVisibility?: SheetVisibility;
  allowIncomingTransfers?: boolean;
  enrichWithLlm?: boolean;
  hasLlmUnlock?: boolean;
  /** Already-encrypted refresh token payload (see src/lib/crypto.ts). */
  googleRefreshTokenEncrypted?: string | null;
}

interface ShelfConfigRow {
  user_id: string;
  spreadsheet_id: string | null;
  sheet_tab_name: string;
  default_visibility: string;
  sheet_visibility: string;
  allow_incoming_transfers: number;
  enrich_with_llm: number;
  has_llm_unlock: number;
  google_refresh_token_encrypted: string | null;
  updated_at: string;
}

const SELECT_COLUMNS =
  "user_id, spreadsheet_id, sheet_tab_name, default_visibility, sheet_visibility, allow_incoming_transfers, enrich_with_llm, has_llm_unlock, google_refresh_token_encrypted, updated_at";

/** Maps a `ShelfConfigPatch` key to its column name. */
const COLUMN_BY_KEY: Record<keyof ShelfConfigPatch, string> = {
  spreadsheetId: "spreadsheet_id",
  sheetTabName: "sheet_tab_name",
  defaultVisibility: "default_visibility",
  sheetVisibility: "sheet_visibility",
  allowIncomingTransfers: "allow_incoming_transfers",
  enrichWithLlm: "enrich_with_llm",
  hasLlmUnlock: "has_llm_unlock",
  googleRefreshTokenEncrypted: "google_refresh_token_encrypted",
};

function toBoolean(value: number): boolean {
  return value !== 0;
}

function mapRow(row: ShelfConfigRow): ShelfConfig {
  return {
    userId: row.user_id,
    spreadsheetId: row.spreadsheet_id,
    sheetTabName: row.sheet_tab_name,
    defaultVisibility:
      row.default_visibility === "shared" ? "shared" : "private",
    sheetVisibility: row.sheet_visibility === "shared" ? "shared" : "private",
    allowIncomingTransfers: toBoolean(row.allow_incoming_transfers),
    enrichWithLlm: toBoolean(row.enrich_with_llm),
    hasLlmUnlock: toBoolean(row.has_llm_unlock),
    hasRefreshToken:
      typeof row.google_refresh_token_encrypted === "string" &&
      row.google_refresh_token_encrypted !== "",
    updatedAt: row.updated_at,
  };
}

/**
 * Phase 5 Level 1 (group membership): the caller identified by the bound
 * parameter and the shelf owner (`sc.user_id`) must both be `active` members of
 * at least one common group. Expressed as a correlated `EXISTS` so it can be
 * appended to any shelf/transfer predicate; it binds exactly one value — the
 * caller's user id.
 */
const ACTIVE_GROUP_OVERLAP = `EXISTS (
            SELECT 1 FROM group_memberships me
              JOIN group_memberships them ON them.group_id = me.group_id
             WHERE me.user_id = ?
               AND me.status = 'active'
               AND them.user_id = sc.user_id
               AND them.status = 'active'
          )`;

/**
 * Read the shelf configuration for a user, or `null` when none exists yet.
 */
export async function getShelfConfig(
  db: D1Database,
  userId: string,
): Promise<ShelfConfig | null> {
  const row = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM shelf_configs WHERE user_id = ? LIMIT 1`,
    )
    .bind(userId)
    .first<ShelfConfigRow>();
  return row ? mapRow(row) : null;
}

/** A shared shelf another user has published for cross-user viewing. */
export interface SharedShelfConfig {
  userId: string;
  /** Owner's account email, shown as the shelf label. */
  ownerEmail: string;
  ownerName: string;
  spreadsheetId: string;
  sheetTabName: string;
}

interface SharedShelfRow {
  user_id: string;
  email: string;
  name: string;
  spreadsheet_id: string;
  sheet_tab_name: string;
}

/**
 * List every other user's shelf that is published for sharing: it must be
 * bound to a spreadsheet, have sheet-level visibility `shared` (Phase 6 — this
 * is the dedicated Level 2 flag, *not* `default_visibility`), still hold a
 * refresh token (without one it cannot be read), and — Phase 5 Level 1 — the
 * viewer and the owner must be `active` members of at least one common group.
 * Ordered by owner email for a stable UI.
 */
export async function listSharedShelfConfigs(
  db: D1Database,
  excludeUserId: string,
): Promise<SharedShelfConfig[]> {
  const result = await db
    .prepare(
      `SELECT sc.user_id, u.email AS email, u.name AS name, sc.spreadsheet_id, sc.sheet_tab_name
         FROM shelf_configs sc
         JOIN "user" u ON u.id = sc.user_id
        WHERE sc.spreadsheet_id IS NOT NULL
          AND sc.sheet_visibility = 'shared'
          AND sc.google_refresh_token_encrypted IS NOT NULL
          AND sc.user_id != ?
          AND ${ACTIVE_GROUP_OVERLAP}
        ORDER BY u.email`,
    )
    .bind(excludeUserId, excludeUserId)
    .all<SharedShelfRow>();

  const rows = result?.results ?? [];
  return rows.map((row) => ({
    userId: row.user_id,
    ownerEmail: row.email,
    ownerName: row.name,
    spreadsheetId: row.spreadsheet_id,
    sheetTabName: row.sheet_tab_name,
  }));
}

/** A user eligible to receive an ownership transfer. */
export interface TransferTarget {
  userId: string;
  email: string;
  name: string;
  spreadsheetId: string;
  sheetTabName: string;
  /** Recipient's `default_visibility`, applied to the appended row. */
  defaultVisibility: DefaultVisibility;
}

/** Fields shown in the dashboard's target-owner picker (no sheet internals). */
export interface TransferTargetOption {
  userId: string;
  email: string;
  name: string;
}

/** Columns selected for the recipient picker. */
interface TransferTargetOptionRow {
  user_id: string;
  email: string;
  name: string;
}

/** Columns needed to append to a resolved recipient's sheet. */
interface TransferTargetRow extends TransferTargetOptionRow {
  spreadsheet_id: string;
  sheet_tab_name: string;
  default_visibility: string;
}

/**
 * The conditions a user must meet to be *able* to receive a transfer: a bound
 * sheet and tab, incoming transfers enabled, and a stored refresh token. This is
 * sender-independent and shared by the picker and the single-target lookup so
 * the two can never drift apart. Phase 5 group scoping is layered on top via
 * {@link ACTIVE_GROUP_OVERLAP} (a join onto active group membership) rather than
 * reshaping the callers.
 */
const TRANSFER_RECEIVABLE_WHERE = [
  "sc.spreadsheet_id IS NOT NULL",
  "sc.sheet_tab_name IS NOT NULL",
  "sc.allow_incoming_transfers = 1",
  "sc.google_refresh_token_encrypted IS NOT NULL",
].join("\n          AND ");

/**
 * Picker predicate: everyone who can receive a transfer, excluding the sender,
 * and restricted to `active` members of a group the sender also belongs to
 * (Phase 5 Level 1). Binds the sender's user id twice — once for the
 * self-exclusion and once for the group-overlap `EXISTS`.
 */
const TRANSFER_ELIGIBILITY_WHERE = `${TRANSFER_RECEIVABLE_WHERE}\n          AND sc.user_id != ?\n          AND ${ACTIVE_GROUP_OVERLAP}`;

/**
 * List users the sender may transfer a book *to*: bound to a sheet, accepting
 * incoming transfers, holding a usable token, not the sender, and sharing at
 * least one active group with the sender. Ordered by email for a stable picker.
 */
export async function listTransferTargets(
  db: D1Database,
  excludeUserId: string,
): Promise<TransferTargetOption[]> {
  const result = await db
    .prepare(
      `SELECT sc.user_id, u.email AS email, u.name AS name
         FROM shelf_configs sc
         JOIN "user" u ON u.id = sc.user_id
        WHERE ${TRANSFER_ELIGIBILITY_WHERE}
        ORDER BY u.email`,
    )
    .bind(excludeUserId, excludeUserId)
    .all<TransferTargetOptionRow>();

  const rows = result?.results ?? [];
  return rows.map((row) => ({
    userId: row.user_id,
    email: row.email,
    name: row.name,
  }));
}

/**
 * Resolve one recipient for a transfer request, returning `null` when the user
 * does not exist, is not currently eligible (bound sheet + incoming transfers +
 * token), or does not share an active group with the sender. Matches the
 * requested user via `sc.user_id = ?` (the picker's `!= ?` self-exclusion is
 * enforced separately in the transfer flow), reusing the same receivable
 * predicate as {@link listTransferTargets} so the picker and the server-side
 * check can never drift apart. Binds the target's id, then the sender's id.
 */
export async function getTransferTarget(
  db: D1Database,
  targetUserId: string,
  fromUserId: string,
): Promise<TransferTarget | null> {
  const row = await db
    .prepare(
      `SELECT sc.user_id, u.email AS email, u.name AS name, sc.spreadsheet_id, sc.sheet_tab_name, sc.default_visibility
         FROM shelf_configs sc
         JOIN "user" u ON u.id = sc.user_id
        WHERE ${TRANSFER_RECEIVABLE_WHERE}
          AND sc.user_id = ?
          AND ${ACTIVE_GROUP_OVERLAP}
        LIMIT 1`,
    )
    .bind(targetUserId, fromUserId)
    .first<TransferTargetRow>();
  if (!row) return null;
  return {
    userId: row.user_id,
    email: row.email,
    name: row.name,
    spreadsheetId: row.spreadsheet_id,
    sheetTabName: row.sheet_tab_name,
    defaultVisibility: row.default_visibility === "shared" ? "shared" : "private",
  };
}

/**
 * Read the encrypted refresh token for a user, or `null` when the user has not
 * connected a Google account. Kept separate so callers never accidentally log
 * the full config row.
 */
export async function getEncryptedRefreshToken(
  db: D1Database,
  userId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      "SELECT google_refresh_token_encrypted FROM shelf_configs WHERE user_id = ? LIMIT 1",
    )
    .bind(userId)
    .first<{ google_refresh_token_encrypted: string | null }>();
  const token = row?.google_refresh_token_encrypted ?? null;
  return token === "" ? null : token;
}

/**
 * Insert-or-update a user's shelf configuration. A missing row is created with
 * column defaults first, then only the supplied patch fields are updated, so
 * callers can persist a single change without clobbering the rest.
 */
export async function upsertShelfConfig(
  db: D1Database,
  userId: string,
  patch: ShelfConfigPatch = {},
): Promise<ShelfConfig> {
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT OR IGNORE INTO shelf_configs (user_id, sheet_tab_name, default_visibility, sheet_visibility, allow_incoming_transfers, enrich_with_llm, has_llm_unlock, updated_at)
       VALUES (?, ?, 'private', 'private', 0, 0, 0, ?)`,
    )
    .bind(userId, DEFAULT_SHEET_TAB_NAME, now)
    .run();

  const assignments: string[] = [];
  const values: unknown[] = [];
  for (const key of Object.keys(patch) as (keyof ShelfConfigPatch)[]) {
    const value = patch[key];
    if (value === undefined) continue;
    assignments.push(`${COLUMN_BY_KEY[key]} = ?`);
    values.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
  }
  assignments.push("updated_at = ?");
  values.push(now, userId);

  await db
    .prepare(
      `UPDATE shelf_configs SET ${assignments.join(", ")} WHERE user_id = ?`,
    )
    .bind(...values)
    .run();

  const config = await getShelfConfig(db, userId);
  if (!config) {
    // The INSERT/UPDATE above guarantees a row; this guards against a driver
    // anomaly rather than a reachable state.
    throw new Error("Failed to persist shelf configuration.");
  }
  return config;
}
