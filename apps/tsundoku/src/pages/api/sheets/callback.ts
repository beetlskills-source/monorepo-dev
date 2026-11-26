import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { encryptSecret } from "../../../lib/crypto";
import {
  createGoogleSheetsClient,
  GoogleSheetsError,
} from "../../../lib/google-sheets";
import {
  clearOAuthStateCookie,
  decodeOAuthStateCookie,
  SHEETS_OAUTH_COOKIE,
} from "../../../lib/sheet-flow";
import { buildSheetsRedirectUri } from "../../../lib/sheet-service";
import { upsertShelfConfig } from "../../../lib/shelf-configs";

export const prerender = false;

/** Where the connect flow returns to, with a human-readable status flag. */
const SETTINGS_PATH = "/settings";

/**
 * Google OAuth redirect target for the incremental `drive.file` consent.
 * Verifies the CSRF `state` against the cookie, exchanges the code (with the
 * PKCE verifier) for tokens, then stores the refresh token encrypted at rest.
 * Creating/binding a spreadsheet is a separate, explicit step on `/settings`.
 *
 * Every exit path clears the short-lived state cookie via an explicit header.
 */
export const GET: APIRoute = async (context) => {
  const secure = buildSheetsRedirectUri(env).startsWith("https://");

  const redirectTo = (location: string): Response =>
    new Response(null, {
      status: 302,
      headers: {
        location,
        "set-cookie": clearOAuthStateCookie(secure),
      },
    });
  const redirectBack = (code: string): Response =>
    redirectTo(`${SETTINGS_PATH}?sheets=${code}`);

  const user = context.locals.user;
  if (!user) {
    return redirectTo("/login?next=%2Fsettings");
  }

  const url = new URL(context.request.url);
  if (url.searchParams.get("error")) {
    return redirectBack("denied");
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieValue = context.cookies.get(SHEETS_OAUTH_COOKIE)?.value ?? "";
  const decoded = decodeOAuthStateCookie(cookieValue);

  if (!code || !state || !decoded || decoded.state !== state) {
    return redirectBack("state_mismatch");
  }

  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  const encryptionKey = env.SHEET_TOKEN_ENCRYPTION_KEY;
  if (!clientId || !clientSecret || !encryptionKey) {
    return redirectBack("config_error");
  }

  const client = createGoogleSheetsClient({ clientId, clientSecret });

  let refreshToken: string | null;
  try {
    const token = await client.exchangeCode({
      code,
      codeVerifier: decoded.verifier,
      redirectUri: buildSheetsRedirectUri(env),
    });
    refreshToken = token.refreshToken;
  } catch (error) {
    console.warn(
      "[sheets-callback] token exchange failed:",
      error instanceof GoogleSheetsError ? error.message : "unexpected error",
    );
    return redirectBack("exchange_failed");
  }

  if (!refreshToken) {
    return redirectBack("no_refresh_token");
  }

  try {
    const encrypted = await encryptSecret(refreshToken, encryptionKey);
    await upsertShelfConfig(env.DB, user.id, {
      googleRefreshTokenEncrypted: encrypted,
    });
  } catch {
    return redirectBack("store_failed");
  }

  return redirectBack("connected");
};
