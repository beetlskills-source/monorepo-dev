/**
 * OWNER-only prerequisites shared by every endpoint that writes to the
 * signed-in user's own Google Sheet: a connected Google account plus a linked
 * spreadsheet. Kept free of Astro APIs (it takes the Worker `env` and a user
 * id) so Phase 3's row routes and the Phase 4 transfer route resolve the same
 * context without duplicating the checks.
 */

import type { GoogleSheetsClient } from "./google-sheets";
import { errorResponse } from "./http";
import { getShelfConfig } from "./shelf-configs";
import {
  createSheetsClient,
  getAuthorizedAccessToken,
  googleSheetsErrorResponse,
  SheetConnectionError,
  SheetsConfigError,
  type SheetsEnv,
} from "./sheet-service";

/** The OWNER-only prerequisites resolved for a sheet write. */
export interface OwnContext {
  client: GoogleSheetsClient;
  accessToken: string;
  spreadsheetId: string;
  sheetTabName: string;
}

/**
 * Resolve the OWNER-only prerequisites (a connected Google account plus a
 * linked spreadsheet) or return the JSON error response describing what is
 * missing. Only ever reads the supplied user's own row, so a caller can never
 * touch another user's shelf through these endpoints.
 */
export async function resolveOwnContext(
  env: SheetsEnv,
  userId: string,
): Promise<OwnContext | Response> {
  const config = await getShelfConfig(env.DB, userId);
  if (!config?.hasRefreshToken) {
    return errorResponse(
      409,
      "SHEET_NOT_CONNECTED",
      "Connect your Google account on the settings page first.",
    );
  }
  if (!config.spreadsheetId) {
    return errorResponse(
      409,
      "SHELF_NOT_CONFIGURED",
      "Create or bind a personal Google Sheet on the settings page first.",
    );
  }

  let client: GoogleSheetsClient;
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
    ({ accessToken } = await getAuthorizedAccessToken(env, client, userId));
  } catch (error) {
    if (error instanceof SheetConnectionError) {
      return errorResponse(409, "SHEET_NOT_CONNECTED", error.message);
    }
    if (error instanceof SheetsConfigError) {
      return errorResponse(503, "CONFIG_ERROR", error.message);
    }
    return googleSheetsErrorResponse(error);
  }

  return {
    client,
    accessToken,
    spreadsheetId: config.spreadsheetId,
    sheetTabName: config.sheetTabName,
  };
}
