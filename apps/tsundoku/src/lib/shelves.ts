/**
 * Server-side glue for the Phase 3/5 dashboard: reading the signed-in user's own
 * shelf and every shared shelf they can view under the three-level visibility
 * model (group membership -> sheet-level `shared` -> row-level group targeting).
 * Kept free of Astro APIs (it takes the Worker `env` and ids) so the routes and
 * the SSR page stay thin and the logic is testable.
 *
 * Shared shelves are read with each owner's stored refresh token (decrypted on
 * the server), so a viewer never sees another user's credentials. Reads are
 * cached in KV when a `SHELF_CACHE` binding is present — the cache holds the
 * owner's *raw* mapped rows (viewer-independent), and the per-viewer group
 * filtering runs after the cache read so no viewer-specific data is cached.
 * Every shared shelf is isolated: one owner's revoked token never takes down
 * the dashboard.
 */

import { GoogleSheetsError } from "./google-sheets";
import { listCommonActiveGroupIds } from "./groups";
import {
  DEFAULT_SHEET_TAB_NAME,
  getShelfConfig,
  listSharedShelfConfigs,
  type SheetVisibility,
} from "./shelf-configs";
import {
  filterSharedRows,
  mapSheetValues,
  rowTargetsGroups,
  shelfColumnRange,
  type ShelfRow,
} from "./shelf-rows";
import {
  createSheetsClient,
  getAuthorizedAccessToken,
  SheetConnectionError,
  SheetsConfigError,
} from "./sheet-service";
import type { SheetsEnv } from "./sheet-service";

/** Bindings the dashboard shelf loaders need (a subset of the Worker `env`). */
export type ShelfEnv = SheetsEnv;

/** How long a shared shelf read stays in KV before it is refetched. */
export const SHARED_SHELF_CACHE_TTL_SECONDS = 60;

export type OwnShelfStatus = "ok" | "not_connected" | "unlinked" | "error";

/** The signed-in user's own shelf, mapped for the dashboard. */
export interface OwnShelfView {
  status: OwnShelfStatus;
  /** Actionable explanation for the `error` state; `null` otherwise. */
  message: string | null;
  spreadsheetId: string | null;
  sheetTabName: string | null;
  title: string | null;
  /**
   * Level 2 of the visibility model: whether the whole sheet is exposed to
   * co-members. Independent of `default_visibility` ("Default visibility for
   * new books"), which only seeds newly scanned rows (Phase 6).
   */
  sheetVisibility: SheetVisibility;
  rows: ShelfRow[];
}

export type SharedShelfStatus = "ok" | "error";

/** Another user's shared shelf, mapped read-only for the dashboard. */
export interface SharedShelfView {
  ownerId: string;
  ownerEmail: string;
  ownerName: string;
  spreadsheetId: string;
  sheetTabName: string;
  title: string | null;
  status: SharedShelfStatus;
  /** Actionable explanation for the `error` state; `null` otherwise. */
  message: string | null;
  /** Active groups the viewer and the owner share; a row must target one. */
  groupIds: string[];
  rows: ShelfRow[];
}

/** KV cache value: the owner's raw mapped rows, before per-viewer filtering. */
interface SharedShelfCacheValue {
  title: string | null;
  rows: ShelfRow[];
}

/**
 * Translate a read failure into an actionable, user-facing sentence. A revoked
 * or expired owner grant is called out explicitly so viewers understand the
 * shelf cannot be read until its owner reconnects.
 */
export function describeShelfError(error: unknown): string {
  if (error instanceof SheetConnectionError) return error.message;
  if (error instanceof SheetsConfigError) return error.message;
  if (error instanceof GoogleSheetsError) {
    if (error.status === 403 || error.status === 404) {
      return "Tsundoku lost access to this Google Sheet. Its owner must reconnect or re-pick the file.";
    }
    if (error.status === 429) {
      return "Google Sheets is rate limiting this account. Wait a moment and try again.";
    }
    return "Google Sheets could not be read right now. Please try again.";
  }
  return "Something went wrong while reading this shelf.";
}

/**
 * Load the signed-in user's own shelf, distinguishing the empty, unlinked, and
 * error states so the page can render clear guidance instead of a blank table.
 */
export async function loadOwnShelf(
  env: ShelfEnv,
  userId: string,
): Promise<OwnShelfView> {
  let config: Awaited<ReturnType<typeof getShelfConfig>>;
  try {
    config = await getShelfConfig(env.DB, userId);
  } catch {
    // A D1 read failure (e.g. a not-yet-migrated deployment) must degrade to an
    // error card rather than crashing the whole dashboard.
    return {
      status: "error",
      message: "Your shelf settings could not be read right now. Please try again.",
      spreadsheetId: null,
      sheetTabName: null,
      title: null,
      sheetVisibility: "private",
      rows: [],
    };
  }
  if (!config?.hasRefreshToken) {
    return {
      status: "not_connected",
      message: null,
      spreadsheetId: null,
      sheetTabName: null,
      title: null,
      sheetVisibility: "private",
      rows: [],
    };
  }
  if (!config.spreadsheetId) {
    return {
      status: "unlinked",
      message: null,
      spreadsheetId: null,
      sheetTabName: config.sheetTabName,
      title: null,
      sheetVisibility: config.sheetVisibility,
      rows: [],
    };
  }

  try {
    const client = createSheetsClient(env);
    const { accessToken } = await getAuthorizedAccessToken(env, client, userId);
    const meta = await client.getSpreadsheetMeta({
      accessToken,
      spreadsheetId: config.spreadsheetId,
    });
    const values = await client.getValues({
      accessToken,
      spreadsheetId: config.spreadsheetId,
      range: shelfColumnRange(config.sheetTabName),
    });
    return {
      status: "ok",
      message: null,
      spreadsheetId: config.spreadsheetId,
      sheetTabName: config.sheetTabName,
      title: meta.title,
      sheetVisibility: config.sheetVisibility,
      rows: mapSheetValues(values),
    };
  } catch (error) {
    return {
      status: "error",
      message: describeShelfError(error),
      spreadsheetId: config.spreadsheetId,
      sheetTabName: config.sheetTabName,
      title: null,
      sheetVisibility: config.sheetVisibility,
      rows: [],
    };
  }
}

/** KV key for a shared shelf read (owner + spreadsheet + tab). */
export function sharedShelfCacheKey(input: {
  userId: string;
  spreadsheetId: string;
  sheetTabName: string;
}): string {
  return `shared:${input.userId}:${input.spreadsheetId}:${input.sheetTabName}`;
}

function isCacheValue(value: unknown): value is SharedShelfCacheValue {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.title === null || typeof record.title === "string") &&
    Array.isArray(record.rows)
  );
}

async function readSharedShelfCache(
  env: ShelfEnv,
  key: string,
): Promise<SharedShelfCacheValue | null> {
  if (!env.SHELF_CACHE) return null;
  try {
    const raw = await env.SHELF_CACHE.get(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isCacheValue(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeSharedShelfCache(
  env: ShelfEnv,
  key: string,
  value: SharedShelfCacheValue,
): Promise<void> {
  if (!env.SHELF_CACHE) return;
  try {
    await env.SHELF_CACHE.put(key, JSON.stringify(value), {
      expirationTtl: SHARED_SHELF_CACHE_TTL_SECONDS,
    });
  } catch {
    // Caching is best-effort; a KV failure must never fail the read.
  }
}

/**
 * Drop the cached shared-shelf read for one owner, so a viewer never sees a
 * stale snapshot after the owner changes their sheet-level visibility or edits
 * a row's visibility/group tags. Keyed on the owner + bound sheet, so a no-op
 * when there is no cache binding or no bound sheet. Never throws.
 */
export async function invalidateSharedShelfCache(
  env: ShelfEnv,
  input: {
    userId: string;
    spreadsheetId: string | null;
    sheetTabName: string | null;
  },
): Promise<void> {
  if (!env.SHELF_CACHE || !input.spreadsheetId) return;
  const key = sharedShelfCacheKey({
    userId: input.userId,
    spreadsheetId: input.spreadsheetId,
    sheetTabName: input.sheetTabName ?? DEFAULT_SHEET_TAB_NAME,
  });
  try {
    await env.SHELF_CACHE.delete(key);
  } catch {
    // Invalidation is best-effort; the TTL bounds any staleness regardless.
  }
}

/**
 * Level 3: keep only rows that are explicitly `shared` *and* targeted at one of
 * the active groups the viewer and the owner share. A zero-tag row (or a row
 * tagged only at groups the pair do not share) is not shown in a group feed.
 */
function visibleRows(rows: ShelfRow[], groupIds: string[]): ShelfRow[] {
  const set = new Set(groupIds);
  return filterSharedRows(rows).filter((row) => rowTargetsGroups(row, set));
}

/**
 * Load one shared shelf, using the KV cache (owner's raw rows) when available.
 * The per-viewer group filter is applied after the cache read so the cached
 * value stays viewer-independent. Never throws.
 */
async function loadSharedShelf(
  env: ShelfEnv,
  summary: {
    userId: string;
    ownerEmail: string;
    ownerName: string;
    spreadsheetId: string;
    sheetTabName: string;
  },
  groupIds: string[],
): Promise<SharedShelfView> {
  const base = {
    ownerId: summary.userId,
    ownerEmail: summary.ownerEmail,
    ownerName: summary.ownerName,
    spreadsheetId: summary.spreadsheetId,
    sheetTabName: summary.sheetTabName,
    groupIds,
  };

  const cacheKey = sharedShelfCacheKey(summary);
  const cached = await readSharedShelfCache(env, cacheKey);
  if (cached) {
    return {
      ...base,
      status: "ok",
      message: null,
      title: cached.title,
      rows: visibleRows(cached.rows, groupIds),
    };
  }

  try {
    const client = createSheetsClient(env);
    const { accessToken } = await getAuthorizedAccessToken(
      env,
      client,
      summary.userId,
    );
    const meta = await client.getSpreadsheetMeta({
      accessToken,
      spreadsheetId: summary.spreadsheetId,
    });
    const values = await client.getValues({
      accessToken,
      spreadsheetId: summary.spreadsheetId,
      range: shelfColumnRange(summary.sheetTabName),
    });
    const rawRows = mapSheetValues(values);
    await writeSharedShelfCache(env, cacheKey, { title: meta.title, rows: rawRows });
    return {
      ...base,
      status: "ok",
      message: null,
      title: meta.title,
      rows: visibleRows(rawRows, groupIds),
    };
  } catch (error) {
    return {
      ...base,
      status: "error",
      message: describeShelfError(error),
      title: null,
      rows: [],
    };
  }
}

/**
 * Load every shared shelf the user can view. Discovery is already scoped to
 * `active` group co-members; each shelf then filters its rows against the exact
 * groups the viewer and its owner share. Per-shelf failures are isolated so a
 * single revoked owner token surfaces as one error card rather than failing the
 * whole dashboard.
 */
export async function loadSharedShelves(
  env: ShelfEnv,
  currentUserId: string,
): Promise<SharedShelfView[]> {
  try {
    const summaries = await listSharedShelfConfigs(env.DB, currentUserId);
    return await Promise.all(
      summaries.map(async (summary) => {
        const groupIds = await listCommonActiveGroupIds(
          env.DB,
          currentUserId,
          summary.userId,
        );
        return loadSharedShelf(env, summary, groupIds);
      }),
    );
  } catch {
    // Discovery can fail if the group tables are unavailable (e.g. a
    // not-yet-migrated deployment). Degrade to "no shared shelves" instead of
    // crashing the dashboard; the per-shelf error isolation is unaffected.
    return [];
  }
}
