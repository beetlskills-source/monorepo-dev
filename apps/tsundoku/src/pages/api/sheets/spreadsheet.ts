import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { extractSpreadsheetId } from "../../../lib/google-sheets";
import {
  createSheetsClient,
  getAuthorizedAccessToken,
  googleSheetsErrorResponse,
  SheetConnectionError,
  SheetsConfigError,
} from "../../../lib/sheet-service";
import { errorResponse, jsonResponse } from "../../../lib/http";

export const prerender = false;

/**
 * List a spreadsheet's title and tab names for the signed-in user, so the UI
 * can offer a tab picker after a file is chosen in the Google Picker modal.
 *
 * With `drive.file` access a spreadsheet the app has not created or the user
 * has not picked resolves to a `404`, which {@link googleSheetsErrorResponse}
 * turns into a clear "re-pick the file" message rather than a generic error.
 */
export const GET: APIRoute = async (context) => {
  const user = context.locals.user;
  if (!user) {
    return errorResponse(
      401,
      "UNAUTHENTICATED",
      "Sign in to use your personal Google Sheet.",
    );
  }

  const spreadsheetId = extractSpreadsheetId(
    context.url.searchParams.get("spreadsheetId") ?? "",
  );
  if (!spreadsheetId) {
    return errorResponse(
      400,
      "INVALID_SPREADSHEET_ID",
      "Provide a Google Sheets URL or a spreadsheet ID.",
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

  try {
    const meta = await client.getSpreadsheetMeta({ accessToken, spreadsheetId });
    return jsonResponse({
      spreadsheetId,
      title: meta.title,
      sheetTitles: meta.sheetTitles,
    });
  } catch (error) {
    return googleSheetsErrorResponse(error);
  }
};
