/**
 * Server-side glue for the Google Sheet connect + save flow. Kept free of
 * Astro APIs (it takes the Worker `env` and a user id) so the routes stay thin
 * and the logic is testable. Every function here touches only the DB, crypto,
 * and the injectable Google client.
 */

import { DEFAULT_BASE_URL } from "./auth";
import { requireEncryptionKey, decryptSecret } from "./crypto";
import {
  createGoogleSheetsClient,
  GoogleSheetsError,
  type GoogleSheetsClient,
} from "./google-sheets";
import { errorResponse } from "./http";
import { getEncryptedRefreshToken } from "./shelf-configs";

/** Path Google redirects back to after the incremental `drive.file` consent. */
export const SHEETS_CALLBACK_PATH = "/api/sheets/callback";

/** The subset of Worker bindings the connect/save flow needs. */
export interface SheetsEnv {
  DB: D1Database;
  BETTER_AUTH_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SHEET_TOKEN_ENCRYPTION_KEY?: string;
  GOOGLE_PICKER_API_KEY?: string;
  GOOGLE_CLOUD_PROJECT_NUMBER?: string;
  /** Optional KV cache for shared-shelf reads; absent deployments degrade safely. */
  SHELF_CACHE?: KVNamespace;
}

/** A freshly-minted access token plus its lifetime, in seconds. */
export interface AuthorizedToken {
  accessToken: string;
  expiresIn: number;
}

/** Public, browser-safe Google configuration for the Picker modal. */
export interface PickerPublicConfig {
  /** Public Picker API key, or `null` when the deployment has not set one. */
  apiKey: string | null;
  /** Google Cloud project number for `setAppId`, when configured. */
  appId: string | null;
  /** OAuth client id (public) the Picker advertises. */
  clientId: string | null;
}

/** Raised when the deployment is missing a required Google/encryption secret. */
export class SheetsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SheetsConfigError";
  }
}

/** Raised when the user has not connected a Google account yet. */
export class SheetConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SheetConnectionError";
  }
}

/** Absolute redirect URI registered in the Google Cloud console. */
export function buildSheetsRedirectUri(env: SheetsEnv): string {
  const base = env.BETTER_AUTH_URL ?? DEFAULT_BASE_URL;
  return `${new URL(base).origin}${SHEETS_CALLBACK_PATH}`;
}

/**
 * Build a Google Sheets client from the Worker bindings, or throw a
 * {@link SheetsConfigError} when the OAuth client is not configured.
 */
export function createSheetsClient(env: SheetsEnv): GoogleSheetsClient {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new SheetsConfigError(
      "Google OAuth is not configured on this deployment.",
    );
  }
  return createGoogleSheetsClient({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
  });
}

/** Default spreadsheet title for a newly-created Tsundoku shelf. */
export function defaultSpreadsheetTitle(email: string): string {
  return `Tsundoku Shelf — ${email}`;
}

/**
 * Public Google configuration for the Picker. Never includes a secret — the
 * API key is expected to be browser-restricted in the Cloud console.
 */
export function getPickerPublicConfig(env: SheetsEnv): PickerPublicConfig {
  return {
    apiKey: env.GOOGLE_PICKER_API_KEY?.trim() || null,
    appId: env.GOOGLE_CLOUD_PROJECT_NUMBER?.trim() || null,
    clientId: env.GOOGLE_CLIENT_ID?.trim() || null,
  };
}

/**
 * True when a token-endpoint failure means the stored refresh token is no
 * longer usable (revoked, expired, or consented away) and the user must
 * reconnect, rather than a transient upstream error worth retrying.
 */
function isReauthRequired(error: unknown): boolean {
  return (
    error instanceof GoogleSheetsError &&
    (error.code === "invalid_grant" || error.status === 400)
  );
}

/**
 * Decrypt the user's stored refresh token and mint a fresh access token.
 * Throws {@link SheetConnectionError} when the user has not connected an
 * account (or when the stored grant is no longer valid and they must
 * re-authorize), and {@link SheetsConfigError} when the encryption key is
 * missing.
 */
export async function getAuthorizedAccessToken(
  env: SheetsEnv,
  client: GoogleSheetsClient,
  userId: string,
): Promise<AuthorizedToken> {
  const encrypted = await getEncryptedRefreshToken(env.DB, userId);
  if (!encrypted) {
    throw new SheetConnectionError(
      "Connect your Google account before using a personal shelf.",
    );
  }
  const refreshToken = await decryptSecret(
    encrypted,
    requireEncryptionKey(env.SHEET_TOKEN_ENCRYPTION_KEY),
  );
  try {
    const { accessToken, expiresIn } =
      await client.refreshAccessToken(refreshToken);
    return { accessToken, expiresIn };
  } catch (error) {
    if (isReauthRequired(error)) {
      throw new SheetConnectionError(
        "Your Google access expired or was revoked. Reconnect your Google account to continue.",
      );
    }
    throw error;
  }
}

/**
 * Best-effort live title of a bound spreadsheet, resolved on the server from
 * the stored `spreadsheet_id` (never used as an identifier). Returns `null`
 * when the user is not connected, the deployment is unconfigured, or Google
 * rejects the metadata read — so pages can fall back to the raw id without
 * failing to render. This reflects external renames made in Google Drive.
 */
export async function resolveSpreadsheetTitle(
  env: SheetsEnv,
  userId: string,
  spreadsheetId: string,
): Promise<string | null> {
  try {
    const client = createSheetsClient(env);
    const { accessToken } = await getAuthorizedAccessToken(env, client, userId);
    const meta = await client.getSpreadsheetMeta({ accessToken, spreadsheetId });
    return meta.title;
  } catch {
    return null;
  }
}

/**
 * Translate a Google Sheets failure into an actionable JSON error response so
 * every sheet route reports consistent, user-facing messages (including the
 * special case of a revoked/expired connection).
 */
export function googleSheetsErrorResponse(error: unknown): Response {
  if (error instanceof GoogleSheetsError) {
    switch (error.status) {
      case 401:
        return errorResponse(
          409,
          "SHEET_NOT_CONNECTED",
          "Your Google connection expired. Reconnect your account to continue.",
        );
      case 403:
        return errorResponse(
          403,
          "SHEET_ACCESS_DENIED",
          "Google denied access to that spreadsheet. Reconnect your Google account, or re-pick the file with 'Browse Google Drive' so Tsundoku can open it.",
        );
      case 404:
        return errorResponse(
          404,
          "SHEET_NOT_FOUND",
          "We could not open that spreadsheet. With per-file (drive.file) access, use 'Browse Google Drive' or 'Create New Google Sheet' to give Tsundoku access, then try again.",
        );
      case 429:
        return errorResponse(
          429,
          "SHEETS_RATE_LIMITED",
          "Google Sheets is rate limiting this account. Wait a moment and try again.",
        );
      default:
        break;
    }
  }
  return errorResponse(
    502,
    "UPSTREAM_ERROR",
    "Google Sheets request failed. Please try again.",
  );
}
