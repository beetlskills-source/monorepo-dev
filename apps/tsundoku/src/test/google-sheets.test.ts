import { describe, expect, it } from "vitest";
import {
  DRIVE_FILE_SCOPE,
  buildGoogleAuthUrl,
  createGoogleSheetsClient,
  extractSpreadsheetId,
  GoogleSheetsError,
} from "../lib/google-sheets";

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Build a fetch stub that records calls and returns a canned response. */
function createFetchStub(handler: (url: string, init?: RequestInit) => Response) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("buildGoogleAuthUrl", () => {
  it("requests offline drive.file consent with PKCE", () => {
    const url = new URL(
      buildGoogleAuthUrl({
        clientId: "cid",
        redirectUri: "https://example.com/api/sheets/callback",
        state: "state-1",
        codeChallenge: "challenge-1",
      }),
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("scope")).toBe(DRIVE_FILE_SCOPE);
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("adds a login hint when provided", () => {
    const url = new URL(
      buildGoogleAuthUrl({
        clientId: "cid",
        redirectUri: "https://example.com/cb",
        state: "s",
        codeChallenge: "c",
        loginHint: "reader@example.com",
      }),
    );
    expect(url.searchParams.get("login_hint")).toBe("reader@example.com");
  });
});

describe("extractSpreadsheetId", () => {
  it("pulls the id out of a Sheets URL", () => {
    expect(
      extractSpreadsheetId(
        "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit#gid=0",
      ),
    ).toBe("1AbCdEfGhIjKlMnOpQrStUvWxYz");
  });

  it("accepts a raw id", () => {
    expect(extractSpreadsheetId("1AbCdEfGhIjKlMnOpQrStUvWxYz")).toBe(
      "1AbCdEfGhIjKlMnOpQrStUvWxYz",
    );
  });

  it("rejects blanks and non-sheet strings", () => {
    expect(extractSpreadsheetId("")).toBeNull();
    expect(extractSpreadsheetId("not a sheet id")).toBeNull();
    expect(extractSpreadsheetId("short")).toBeNull();
  });
});

describe("createGoogleSheetsClient", () => {
  it("exchanges an authorization code with the PKCE verifier", async () => {
    const { fetchImpl, calls } = createFetchStub(() =>
      jsonResponse({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
        scope: DRIVE_FILE_SCOPE,
      }),
    );
    const client = createGoogleSheetsClient({
      clientId: "cid",
      clientSecret: "cs",
      fetchImpl,
    });

    const token = await client.exchangeCode({
      code: "auth-code",
      codeVerifier: "verifier",
      redirectUri: "https://example.com/cb",
    });

    expect(token).toEqual({
      accessToken: "access",
      refreshToken: "refresh",
      expiresIn: 3600,
      scope: DRIVE_FILE_SCOPE,
    });
    const body = String(calls[0]?.init?.body ?? "");
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code_verifier=verifier");
    expect(body).toContain("client_id=cid");
  });

  it("refreshes an access token from a refresh token", async () => {
    const { fetchImpl, calls } = createFetchStub(() =>
      jsonResponse({ access_token: "fresh", expires_in: 1800 }),
    );
    const client = createGoogleSheetsClient({
      clientId: "cid",
      clientSecret: "cs",
      fetchImpl,
    });

    const token = await client.refreshAccessToken("stored-refresh");
    expect(token.accessToken).toBe("fresh");
    expect(String(calls[0]?.init?.body ?? "")).toContain(
      "grant_type=refresh_token",
    );
  });

  it("creates a spreadsheet with a named first tab", async () => {
    const { fetchImpl, calls } = createFetchStub(() =>
      jsonResponse({
        spreadsheetId: "sheet-1",
        spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1",
      }),
    );
    const client = createGoogleSheetsClient({
      clientId: "cid",
      clientSecret: "cs",
      fetchImpl,
    });

    const created = await client.createSpreadsheet({
      accessToken: "access",
      title: "Tsundoku Shelf",
      sheetTitle: "Books",
    });

    expect(created.spreadsheetId).toBe("sheet-1");
    const sent = JSON.parse(String(calls[0]?.init?.body ?? "{}"));
    expect(sent.properties.title).toBe("Tsundoku Shelf");
    expect(sent.sheets[0].properties.title).toBe("Books");
  });

  it("parses spreadsheet metadata titles", async () => {
    const { fetchImpl } = createFetchStub(() =>
      jsonResponse({
        properties: { title: "My Shelf" },
        sheets: [
          { properties: { title: "Books" } },
          { properties: { title: "Wishlist" } },
        ],
      }),
    );
    const client = createGoogleSheetsClient({
      clientId: "cid",
      clientSecret: "cs",
      fetchImpl,
    });

    const meta = await client.getSpreadsheetMeta({
      accessToken: "access",
      spreadsheetId: "sheet-1",
    });
    expect(meta.title).toBe("My Shelf");
    expect(meta.sheetTitles).toEqual(["Books", "Wishlist"]);
  });

  it("appends rows with RAW input and INSERT_ROWS", async () => {
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse({}));
    const client = createGoogleSheetsClient({
      clientId: "cid",
      clientSecret: "cs",
      fetchImpl,
    });

    await client.appendValues({
      accessToken: "access",
      spreadsheetId: "sheet-1",
      range: "'Books'!A1",
      values: [["a", "b"]],
    });

    expect(calls[0]?.url).toContain("/spreadsheets/sheet-1/values/");
    expect(calls[0]?.url).toContain(
      ":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS",
    );
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body ?? "{}"))).toEqual({
      values: [["a", "b"]],
    });
  });

  it("updates values with RAW input via PUT", async () => {
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse({}));
    const client = createGoogleSheetsClient({
      clientId: "cid",
      clientSecret: "cs",
      fetchImpl,
    });

    await client.updateValues({
      accessToken: "access",
      spreadsheetId: "sheet-1",
      range: "'Books'!A1:N1",
      values: [["h1", "h2"]],
    });

    expect(calls[0]?.url).toContain("?valueInputOption=RAW");
    expect(calls[0]?.init?.method).toBe("PUT");
  });

  it("surfaces Google errors as GoogleSheetsError with status and code", async () => {
    const { fetchImpl } = createFetchStub(() =>
      jsonResponse({ error: { message: "The caller does not have permission", code: 403 } }, 403),
    );
    const client = createGoogleSheetsClient({
      clientId: "cid",
      clientSecret: "cs",
      fetchImpl,
    });

    await expect(client.refreshAccessToken("stored")).rejects.toMatchObject({
      name: "GoogleSheetsError",
      status: 403,
      code: "403",
      message: "The caller does not have permission",
    });
  });

  it("wraps transport failures as GoogleSheetsError", async () => {
    const failingFetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const client = createGoogleSheetsClient({
      clientId: "cid",
      clientSecret: "cs",
      fetchImpl: failingFetch,
    });

    await expect(client.refreshAccessToken("stored")).rejects.toBeInstanceOf(
      GoogleSheetsError,
    );
  });
});
