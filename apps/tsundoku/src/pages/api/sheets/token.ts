import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  createSheetsClient,
  getAuthorizedAccessToken,
  googleSheetsErrorResponse,
  SheetConnectionError,
  SheetsConfigError,
} from "../../../lib/sheet-service";
import { errorResponse } from "../../../lib/http";

export const prerender = false;

/**
 * Mint a short-lived access token for the signed-in user.
 *
 * The refresh token stays server-side (encrypted in D1); only the derived,
 * short-lived access token is returned, because the Google Picker modal and
 * client-side Sheets calls both need it and neither can hold the refresh token.
 * The response is marked `no-store` so the token is never cached.
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

  let client;
  try {
    client = createSheetsClient(env);
  } catch (error) {
    if (error instanceof SheetsConfigError) {
      return errorResponse(503, "CONFIG_ERROR", error.message);
    }
    throw error;
  }

  let token;
  try {
    token = await getAuthorizedAccessToken(env, client, user.id);
  } catch (error) {
    if (error instanceof SheetConnectionError) {
      return errorResponse(409, "SHEET_NOT_CONNECTED", error.message);
    }
    if (error instanceof SheetsConfigError) {
      return errorResponse(503, "CONFIG_ERROR", error.message);
    }
    return googleSheetsErrorResponse(error);
  }

  const response = Response.json({
    accessToken: token.accessToken,
    expiresIn: token.expiresIn,
  });
  response.headers.set("cache-control", "no-store");
  return response;
};
