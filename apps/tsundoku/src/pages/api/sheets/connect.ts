import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { buildGoogleAuthUrl, DRIVE_FILE_SCOPE } from "../../../lib/google-sheets";
import {
  createPkcePair,
  createRandomToken,
  encodeOAuthStateCookie,
  serializeOAuthStateCookie,
} from "../../../lib/sheet-flow";
import { buildSheetsRedirectUri } from "../../../lib/sheet-service";
import { errorResponse } from "../../../lib/http";

export const prerender = false;

/**
 * Start the incremental `drive.file` authorization. Sign-in (Better Auth) is
 * deliberately separate, so this is the only place the Sheets/Drive scope is
 * requested — and only when the user explicitly clicks "Connect".
 *
 * The PKCE verifier and CSRF `state` travel in a short-lived HttpOnly cookie so
 * the callback can verify the round-trip without extra server state. The cookie
 * is attached to the redirect directly, so it does not depend on adapter-
 * specific cookie merging for endpoints.
 */
export const GET: APIRoute = async (context) => {
  const user = context.locals.user;
  if (!user) {
    return errorResponse(
      401,
      "UNAUTHENTICATED",
      "Sign in to connect a personal Google Sheet.",
    );
  }

  const clientId = env.GOOGLE_CLIENT_ID;
  if (!clientId || !env.GOOGLE_CLIENT_SECRET) {
    return errorResponse(
      503,
      "CONFIG_ERROR",
      "Google OAuth is not configured on this deployment.",
    );
  }

  const redirectUri = buildSheetsRedirectUri(env);
  const secure = redirectUri.startsWith("https://");
  const state = createRandomToken(32);
  const { verifier, challenge } = await createPkcePair();
  const cookie = encodeOAuthStateCookie(state, verifier);

  const authUrl = buildGoogleAuthUrl({
    clientId,
    redirectUri,
    state,
    codeChallenge: challenge,
    scopes: [DRIVE_FILE_SCOPE],
    loginHint: user.email,
  });

  return new Response(null, {
    status: 302,
    headers: {
      location: authUrl,
      "set-cookie": serializeOAuthStateCookie(cookie, secure),
    },
  });
};
