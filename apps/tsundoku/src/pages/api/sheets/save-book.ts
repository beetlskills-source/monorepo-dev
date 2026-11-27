import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { SaveableBookSchema } from "@repo/book-schemas";
import { buildSheetRow, sheetRange, type SaveBookRequest } from "../../../lib/sheet-flow";
import {
  createSheetsClient,
  getAuthorizedAccessToken,
  googleSheetsErrorResponse,
  SheetConnectionError,
  SheetsConfigError,
} from "../../../lib/sheet-service";
import { getShelfConfig } from "../../../lib/shelf-configs";
import { errorResponse, jsonResponse } from "../../../lib/http";

export const prerender = false;

/**
 * Append a normalized book row to the signed-in user's personal Google Sheet.
 * Unlike the ephemeral lookup result, this persists into the user's own
 * spreadsheet — so it requires both an authenticated session and a connected
 * sheet, and reports a clear, actionable error for each missing prerequisite.
 */
export const POST: APIRoute = async (context) => {
  const user = context.locals.user;
  if (!user) {
    return errorResponse(
      401,
      "UNAUTHENTICATED",
      "Sign in to save books to your shelf.",
    );
  }

  let payload: unknown;
  try {
    payload = await context.request.json();
  } catch {
    return errorResponse(400, "INVALID_REQUEST", "Request body must be valid JSON.");
  }

  const envelope = payload as Partial<SaveBookRequest> | null;
  const book = SaveableBookSchema.safeParse(envelope?.book);
  if (!book.success) {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      "Provide a 'book' object with at least a non-empty 'title'.",
    );
  }

  const config = await getShelfConfig(env.DB, user.id);
  if (!config?.hasRefreshToken) {
    return errorResponse(
      409,
      "SHEET_NOT_CONNECTED",
      "Connect your Google account on the settings page before saving books.",
    );
  }
  if (!config.spreadsheetId) {
    return errorResponse(
      409,
      "SHELF_NOT_CONFIGURED",
      "Create or bind a personal Google Sheet on the settings page first.",
    );
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

  const addedAt = new Date().toISOString();
  const row = buildSheetRow({
    book: book.data,
    visibility: config.defaultVisibility,
    ownerEmail: user.email,
    addedAt,
  });

  try {
    await client.appendValues({
      accessToken,
      spreadsheetId: config.spreadsheetId,
      range: sheetRange(config.sheetTabName, "A1"),
      values: [row],
    });
  } catch (error) {
    return googleSheetsErrorResponse(error);
  }

  return jsonResponse({ ok: true, addedAt, row });
};
