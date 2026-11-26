import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { errorResponse, jsonResponse } from "../../../../lib/http";
import { listActiveGroupIds } from "../../../../lib/groups";
import { resolveOwnContext } from "../../../../lib/own-shelf";
import { invalidateSharedShelfCache } from "../../../../lib/shelves";
import {
  applyRowEdits,
  isEmptyRow,
  parseGroupIds,
  serializeGroupIds,
  shelfRowFromCanonical,
  shelfRowRange,
  shelfRowToValues,
  ShelfRowDeleteSchema,
  ShelfRowEditSchema,
} from "../../../../lib/shelf-rows";
import { googleSheetsErrorResponse } from "../../../../lib/sheet-service";

export const prerender = false;

/**
 * Edit the editable fields of one row on the signed-in user's own sheet. The
 * row is read first so values are patched onto the authoritative provenance
 * columns (isbn13, source, ownerEmail, …) rather than overwriting them.
 */
export const PATCH: APIRoute = async (context) => {
  const user = context.locals.user;
  if (!user) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to edit your shelf.");
  }

  let payload: unknown;
  try {
    payload = await context.request.json();
  } catch {
    return errorResponse(400, "INVALID_REQUEST", "Request body must be valid JSON.");
  }

  const parsed = ShelfRowEditSchema.safeParse(payload);
  if (!parsed.success) {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      "Provide a rowIndex (>= 2) and the fields to update.",
    );
  }
  const { rowIndex, fields } = parsed.data;

  // Phase 5: a row may only be tagged with groups the user is an `active`
  // member of, so group feeds can never be spoofed with a foreign group id.
  if (fields.groups !== undefined) {
    const requested = parseGroupIds(fields.groups);
    const activeGroupIds = new Set(await listActiveGroupIds(env.DB, user.id));
    if (requested.some((id) => !activeGroupIds.has(id))) {
      return errorResponse(
        400,
        "UNKNOWN_GROUP",
        "You can only share a row with groups you belong to.",
      );
    }
    fields.groups = serializeGroupIds(requested);
  }

  const ctx = await resolveOwnContext(env, user.id);
  if (ctx instanceof Response) return ctx;

  const range = shelfRowRange(ctx.sheetTabName, rowIndex);
  let current: string[];
  try {
    const values = await ctx.client.getValues({
      accessToken: ctx.accessToken,
      spreadsheetId: ctx.spreadsheetId,
      range,
    });
    current = values[0] ?? [];
  } catch (error) {
    return googleSheetsErrorResponse(error);
  }

  const row = shelfRowFromCanonical(rowIndex, current);
  if (isEmptyRow(row)) {
    return errorResponse(
      404,
      "ROW_NOT_FOUND",
      "That row no longer exists. Refresh the shelf and try again.",
    );
  }

  const updated = applyRowEdits(row, fields);
  try {
    await ctx.client.updateValues({
      accessToken: ctx.accessToken,
      spreadsheetId: ctx.spreadsheetId,
      range,
      values: [shelfRowToValues(updated)],
    });
  } catch (error) {
    return googleSheetsErrorResponse(error);
  }

  // Level 3 changed (a row's visibility and/or group tags): drop the owner's
  // cached shared read so co-members reflect the edit without waiting for TTL.
  await invalidateSharedShelfCache(env, {
    userId: user.id,
    spreadsheetId: ctx.spreadsheetId,
    sheetTabName: ctx.sheetTabName,
  });

  return jsonResponse({ ok: true, row: updated });
};

/**
 * Delete one row from the signed-in user's own sheet. Uses `deleteDimension`
 * (via `batchUpdate`) keyed on the tab's numeric sheet id, so the grid shifts
 * up cleanly and remaining row indices stay consistent.
 */
export const DELETE: APIRoute = async (context) => {
  const user = context.locals.user;
  if (!user) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to edit your shelf.");
  }

  let payload: unknown;
  try {
    payload = await context.request.json();
  } catch {
    return errorResponse(400, "INVALID_REQUEST", "Request body must be valid JSON.");
  }

  const parsed = ShelfRowDeleteSchema.safeParse(payload);
  if (!parsed.success) {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      "Provide the rowIndex (>= 2) to delete.",
    );
  }
  const { rowIndex } = parsed.data;

  const ctx = await resolveOwnContext(env, user.id);
  if (ctx instanceof Response) return ctx;

  // `deleteDimension` needs the tab's numeric grid id, so read it first.
  let sheetId: number | null = null;
  try {
    const meta = await ctx.client.getSpreadsheetMeta({
      accessToken: ctx.accessToken,
      spreadsheetId: ctx.spreadsheetId,
    });
    const match = meta.sheets.find((sheet) => sheet.title === ctx.sheetTabName);
    sheetId = match?.sheetId ?? null;
  } catch (error) {
    return googleSheetsErrorResponse(error);
  }
  if (sheetId === null) {
    return errorResponse(
      404,
      "SHEET_TAB_NOT_FOUND",
      `The tab "${ctx.sheetTabName}" no longer exists in that spreadsheet.`,
    );
  }

  try {
    await ctx.client.batchUpdate({
      accessToken: ctx.accessToken,
      spreadsheetId: ctx.spreadsheetId,
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: rowIndex - 1,
              endIndex: rowIndex,
            },
          },
        },
      ],
    });
  } catch (error) {
    return googleSheetsErrorResponse(error);
  }

  // A removed row changes the shared view: invalidate the owner's cached read.
  await invalidateSharedShelfCache(env, {
    userId: user.id,
    spreadsheetId: ctx.spreadsheetId,
    sheetTabName: ctx.sheetTabName,
  });

  return jsonResponse({ ok: true, rowIndex });
};
