import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { extractSpreadsheetId } from "../../../lib/google-sheets";
import {
  sheetHeaderRange,
  sheetRange,
  SHEET_HEADER_ROW,
  ShelfSetupRequestSchema,
} from "../../../lib/sheet-flow";
import {
  createSheetsClient,
  defaultSpreadsheetTitle,
  getAuthorizedAccessToken,
  googleSheetsErrorResponse,
  SheetConnectionError,
  SheetsConfigError,
} from "../../../lib/sheet-service";
import {
  DEFAULT_SHEET_TAB_NAME,
  upsertShelfConfig,
  type ShelfConfig,
} from "../../../lib/shelf-configs";
import { errorResponse, jsonResponse } from "../../../lib/http";

export const prerender = false;

/** The safe, secret-free projection of a shelf config returned to the client. */
function serializeConfig(config: ShelfConfig) {
  return {
    spreadsheetId: config.spreadsheetId,
    sheetTabName: config.sheetTabName,
    defaultVisibility: config.defaultVisibility,
    allowIncomingTransfers: config.allowIncomingTransfers,
    connected: config.hasRefreshToken,
  };
}

/**
 * Configure the user's personal shelf: create a fresh "Tsundoku Shelf"
 * spreadsheet (with the canonical header row), bind an existing spreadsheet by
 * id/URL, or detach the current binding. Requires the `drive.file` connection
 * established through `/api/sheets/connect`.
 */
export const POST: APIRoute = async (context) => {
  const user = context.locals.user;
  if (!user) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to configure your shelf.");
  }

  let payload: unknown;
  try {
    payload = await context.request.json();
  } catch {
    return errorResponse(400, "INVALID_REQUEST", "Request body must be valid JSON.");
  }

  const parsed = ShelfSetupRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      "Provide an action of 'create', 'bind', or 'detach'.",
    );
  }

  if (parsed.data.action === "detach") {
    const config = await upsertShelfConfig(env.DB, user.id, {
      spreadsheetId: null,
      googleRefreshTokenEncrypted: null,
    });
    return jsonResponse({ ok: true, config: serializeConfig(config) });
  }

  let client;
  try {
    client = createSheetsClient(env);
  } catch (error) {
    if (error instanceof SheetsConfigError) {
      return errorResponse(503, "CONFIG_ERROR", error.message);
    }
    throw error;
  }

  let accessToken: string;
  try {
    ({ accessToken } = await getAuthorizedAccessToken(env, client, user.id));
  } catch (error) {
    if (error instanceof SheetConnectionError) {
      return errorResponse(409, "SHEET_NOT_CONNECTED", error.message);
    }
    if (error instanceof SheetsConfigError) {
      return errorResponse(503, "CONFIG_ERROR", error.message);
    }
    return googleSheetsErrorResponse(error);
  }

  try {
    if (parsed.data.action === "create") {
      const title = defaultSpreadsheetTitle(user.email);
      const created = await client.createSpreadsheet({
        accessToken,
        title,
        sheetTitle: DEFAULT_SHEET_TAB_NAME,
      });
      await client.updateValues({
        accessToken,
        spreadsheetId: created.spreadsheetId,
        range: sheetHeaderRange(DEFAULT_SHEET_TAB_NAME),
        values: [[...SHEET_HEADER_ROW]],
      });
      const config = await upsertShelfConfig(env.DB, user.id, {
        spreadsheetId: created.spreadsheetId,
        sheetTabName: DEFAULT_SHEET_TAB_NAME,
      });
      return jsonResponse({
        ok: true,
        spreadsheetUrl: created.spreadsheetUrl,
        spreadsheetTitle: title,
        config: serializeConfig(config),
      });
    }

    const spreadsheetId = extractSpreadsheetId(parsed.data.spreadsheetId ?? "");
    if (!spreadsheetId) {
      return errorResponse(
        400,
        "INVALID_SPREADSHEET_ID",
        "Provide a Google Sheets URL or a spreadsheet ID.",
      );
    }

    const meta = await client.getSpreadsheetMeta({ accessToken, spreadsheetId });
    const requestedTab = parsed.data.sheetTabName;
    const tabName =
      requestedTab && meta.sheetTitles.includes(requestedTab)
        ? requestedTab
        : (meta.sheetTitles[0] ?? DEFAULT_SHEET_TAB_NAME);

    // Backfill the header row when the target tab is still empty, so a bound
    // sheet is immediately ready to receive rows.
    const existing = await client.getValues({
      accessToken,
      spreadsheetId,
      range: sheetRange(tabName, "A1:A1"),
    });
    const hasContent =
      existing.length > 0 && (existing[0]?.some((cell) => cell.trim() !== "") ?? false);
    if (!hasContent) {
      await client.updateValues({
        accessToken,
        spreadsheetId,
        range: sheetHeaderRange(tabName),
        values: [[...SHEET_HEADER_ROW]],
      });
    }

    const config = await upsertShelfConfig(env.DB, user.id, {
      spreadsheetId,
      sheetTabName: tabName,
    });
    return jsonResponse({
      ok: true,
      spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
      spreadsheetTitle: meta.title,
      config: serializeConfig(config),
    });
  } catch (error) {
    return googleSheetsErrorResponse(error);
  }
};
