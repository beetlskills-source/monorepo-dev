/**
 * Fetch-based Google OAuth + Google Sheets REST client for the incremental
 * `drive.file` connect flow (Phase 2).
 *
 * Two deliberate properties:
 *  - It only ever requests the `drive.file` scope, so signing in elsewhere
 *    (Better Auth) stays lightweight and this consent is strictly incremental.
 *  - `fetchImpl` is injectable so the whole client is deterministic in tests
 *    without touching the network.
 */

export const GOOGLE_AUTH_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

/** Per-file access to spreadsheets this app creates or the user selects. */
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export const DEFAULT_GOOGLE_TIMEOUT_MS = 10_000;

/** Raised when a Google endpoint fails at the network/HTTP boundary. */
export class GoogleSheetsError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "GoogleSheetsError";
    this.status = status;
    this.code = code;
  }
}

export interface GoogleTokenResponse {
  accessToken: string;
  /** Present only on the initial consent (with `prompt=consent`, always set). */
  refreshToken: string | null;
  expiresIn: number;
  scope: string | null;
}

export interface GoogleSheetsClient {
  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<GoogleTokenResponse>;
  refreshAccessToken(
    refreshToken: string,
  ): Promise<{ accessToken: string; expiresIn: number }>;
  createSpreadsheet(input: {
    accessToken: string;
    title: string;
    /** Title for the first tab; defaults to Google's "Sheet1" when omitted. */
    sheetTitle?: string;
  }): Promise<{
    spreadsheetId: string;
    spreadsheetUrl: string | null;
  }>;
  /** Discover a spreadsheet's title and the tabs it contains. */
  getSpreadsheetMeta(input: { accessToken: string; spreadsheetId: string }): Promise<{
    title: string | null;
    sheetTitles: string[];
    /** Per-tab title + numeric grid id (used by `batchUpdate` row deletes). */
    sheets: Array<{ title: string; sheetId: number | null }>;
  }>;
  getValues(input: {
    accessToken: string;
    spreadsheetId: string;
    range: string;
  }): Promise<string[][]>;
  appendValues(input: {
    accessToken: string;
    spreadsheetId: string;
    range: string;
    values: string[][];
  }): Promise<void>;
  updateValues(input: {
    accessToken: string;
    spreadsheetId: string;
    range: string;
    values: string[][];
  }): Promise<void>;
  /** Run batched structural edits (e.g. `deleteDimension` to remove a row). */
  batchUpdate(input: {
    accessToken: string;
    spreadsheetId: string;
    requests: unknown[];
  }): Promise<void>;
}

export interface GoogleSheetsClientOptions {
  clientId: string;
  clientSecret: string;
  /** Injectable fetch, mainly for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Build the Google authorization URL that requests `drive.file` consent with
 * PKCE. `access_type=offline` + `prompt=consent` guarantee a refresh token is
 * returned so the connection survives past the initial access token.
 */
export function buildGoogleAuthUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: string[];
  loginHint?: string;
}): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set(
    "scope",
    (input.scopes ?? [DRIVE_FILE_SCOPE]).join(" "),
  );
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
  return url.toString();
}

/**
 * Accept either a raw spreadsheet id or a full Google Sheets URL and return the
 * id, or `null` when neither shape is recognizable.
 */
export function extractSpreadsheetId(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;

  const urlMatch = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (urlMatch && urlMatch[1]) return urlMatch[1];

  if (/^[a-zA-Z0-9-_]{20,}$/.test(trimmed)) return trimmed;
  return null;
}

function toValuesMatrix(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  return value.map((row) =>
    Array.isArray(row)
      ? row.map((cell) => (typeof cell === "string" ? cell : String(cell ?? "")))
      : [],
  );
}

/**
 * Create an injectable Google Sheets client. It reads no secrets itself; the
 * caller supplies `clientId` / `clientSecret` from the Worker `env`.
 */
export function createGoogleSheetsClient(
  options: GoogleSheetsClientOptions,
): GoogleSheetsClient {
  const { clientId, clientSecret } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_GOOGLE_TIMEOUT_MS;

  async function readError(
    response: Response,
  ): Promise<{ message: string; code?: string }> {
    try {
      const body = asRecord(await response.json());
      const error = body ? asRecord(body.error) : null;
      const message =
        error && typeof error.message === "string"
          ? error.message
          : `Google responded with status ${response.status}`;
      const code =
        error && typeof error.code === "string"
          ? error.code
          : error && typeof error.code === "number"
            ? String(error.code)
            : undefined;
      return { message, code };
    } catch {
      return { message: `Google responded with status ${response.status}` };
    }
  }

  async function requestJson(
    url: string,
    init: RequestInit,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new GoogleSheetsError("Google request failed or timed out");
    }
    if (!response.ok) {
      const { message, code } = await readError(response);
      throw new GoogleSheetsError(message, response.status, code);
    }
    try {
      return await response.json();
    } catch {
      throw new GoogleSheetsError("Google returned an invalid JSON response");
    }
  }

  async function postTokenForm(
    params: Record<string, string>,
  ): Promise<GoogleTokenResponse> {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      ...params,
    });
    const data = asRecord(
      await requestJson(GOOGLE_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
    );
    const accessToken =
      data && typeof data.access_token === "string" ? data.access_token : null;
    if (!accessToken) {
      throw new GoogleSheetsError("Google token response was missing a token");
    }
    return {
      accessToken,
      refreshToken:
        data && typeof data.refresh_token === "string"
          ? data.refresh_token
          : null,
      expiresIn:
        data && typeof data.expires_in === "number" ? data.expires_in : 3600,
      scope: data && typeof data.scope === "string" ? data.scope : null,
    };
  }

  function authHeaders(accessToken: string): Record<string, string> {
    return {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    };
  }

  function valuesUrl(spreadsheetId: string, range: string): string {
    return `${GOOGLE_SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
  }

  return {
    async exchangeCode({ code, codeVerifier, redirectUri }) {
      return postTokenForm({
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      });
    },

    async refreshAccessToken(refreshToken) {
      const data = await postTokenForm({
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      });
      return { accessToken: data.accessToken, expiresIn: data.expiresIn };
    },

    async createSpreadsheet({ accessToken, title, sheetTitle }) {
      const body: Record<string, unknown> = { properties: { title } };
      if (sheetTitle) {
        body.sheets = [{ properties: { title: sheetTitle } }];
      }
      const data = asRecord(
        await requestJson(GOOGLE_SHEETS_API, {
          method: "POST",
          headers: authHeaders(accessToken),
          body: JSON.stringify(body),
        }),
      );
      const spreadsheetId =
        data && typeof data.spreadsheetId === "string"
          ? data.spreadsheetId
          : null;
      if (!spreadsheetId) {
        throw new GoogleSheetsError(
          "Google did not return a spreadsheet id",
        );
      }
      return {
        spreadsheetId,
        spreadsheetUrl:
          data && typeof data.spreadsheetUrl === "string"
            ? data.spreadsheetUrl
            : null,
      };
    },

    async getSpreadsheetMeta({ accessToken, spreadsheetId }) {
      // Ask only for the title and the tab titles/ids, keeping the payload minimal.
      const url =
        `${GOOGLE_SHEETS_API}/${encodeURIComponent(spreadsheetId)}` +
        "?fields=properties.title,sheets.properties.title,sheets.properties.sheetId";
      const data = asRecord(
        await requestJson(url, {
          method: "GET",
          headers: authHeaders(accessToken),
        }),
      );
      const properties = asRecord(data?.properties);
      const sheetEntries = Array.isArray(data?.sheets) ? data.sheets : [];
      const sheets: Array<{ title: string; sheetId: number | null }> = [];
      for (const entry of sheetEntries) {
        const tab = asRecord(asRecord(entry)?.properties);
        if (!tab || typeof tab.title !== "string") continue;
        sheets.push({
          title: tab.title,
          sheetId: typeof tab.sheetId === "number" ? tab.sheetId : null,
        });
      }
      return {
        title:
          properties && typeof properties.title === "string"
            ? properties.title
            : null,
        sheetTitles: sheets.map((sheet) => sheet.title),
        sheets,
      };
    },

    async getValues({ accessToken, spreadsheetId, range }) {
      const data = asRecord(
        await requestJson(valuesUrl(spreadsheetId, range), {
          method: "GET",
          headers: authHeaders(accessToken),
        }),
      );
      return toValuesMatrix(data?.values);
    },

    async appendValues({ accessToken, spreadsheetId, range, values }) {
      const url = `${valuesUrl(spreadsheetId, range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
      await requestJson(url, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({ values }),
      });
    },

    async updateValues({ accessToken, spreadsheetId, range, values }) {
      const url = `${valuesUrl(spreadsheetId, range)}?valueInputOption=RAW`;
      await requestJson(url, {
        method: "PUT",
        headers: authHeaders(accessToken),
        body: JSON.stringify({ values }),
      });
    },

    async batchUpdate({ accessToken, spreadsheetId, requests }) {
      const url = `${GOOGLE_SHEETS_API}/${encodeURIComponent(spreadsheetId)}:batchUpdate`;
      await requestJson(url, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({ requests }),
      });
    },
  };
}
