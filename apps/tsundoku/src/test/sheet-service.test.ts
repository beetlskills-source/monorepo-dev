import { describe, expect, it } from "vitest";
import { encryptSecret } from "../lib/crypto";
import { GoogleSheetsError, type GoogleSheetsClient } from "../lib/google-sheets";
import {
  getAuthorizedAccessToken,
  getPickerPublicConfig,
  SheetConnectionError,
  type SheetsEnv,
} from "../lib/sheet-service";

/** Minimal D1 double whose `first()` returns a stored encrypted token row. */
function createDb(encrypted: string | null): D1Database {
  const db = {
    prepare() {
      const statement = {
        bind() {
          return statement;
        },
        async first() {
          return encrypted === null
            ? null
            : { google_refresh_token_encrypted: encrypted };
        },
        async run() {
          return { success: true };
        },
      };
      return statement;
    },
  };
  return db as unknown as D1Database;
}

/** Client double exposing only the refresh path the service uses. */
function createClient(
  refresh: (token: string) => Promise<{ accessToken: string; expiresIn: number }>,
): GoogleSheetsClient {
  return { refreshAccessToken: refresh } as unknown as GoogleSheetsClient;
}

const ENCRYPTION_KEY = "test-encryption-key";

async function envWithToken(token: string): Promise<SheetsEnv> {
  const encrypted = await encryptSecret(token, ENCRYPTION_KEY);
  return { DB: createDb(encrypted), SHEET_TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY };
}

describe("getPickerPublicConfig", () => {
  it("returns the public key and project number, trimming whitespace", () => {
    const config = getPickerPublicConfig({
      DB: createDb(null),
      GOOGLE_PICKER_API_KEY: " picker-key ",
      GOOGLE_CLOUD_PROJECT_NUMBER: " 123456 ",
      GOOGLE_CLIENT_ID: "client-id",
    });
    expect(config).toEqual({
      apiKey: "picker-key",
      appId: "123456",
      clientId: "client-id",
    });
  });

  it("nulls out blank or missing values", () => {
    const config = getPickerPublicConfig({ DB: createDb(null) });
    expect(config).toEqual({ apiKey: null, appId: null, clientId: null });

    const blank = getPickerPublicConfig({ DB: createDb(null), GOOGLE_PICKER_API_KEY: "  " });
    expect(blank.apiKey).toBeNull();
  });
});

describe("getAuthorizedAccessToken", () => {
  it("mints an access token with its lifetime from the stored refresh token", async () => {
    const env = await envWithToken("stored-refresh");
    let received = "";
    const client = createClient(async (token) => {
      received = token;
      return { accessToken: "fresh-access", expiresIn: 1800 };
    });

    const result = await getAuthorizedAccessToken(env, client, "user-1");
    expect(received).toBe("stored-refresh");
    expect(result).toEqual({ accessToken: "fresh-access", expiresIn: 1800 });
  });

  it("prompts a reconnect when no account is connected", async () => {
    const env: SheetsEnv = {
      DB: createDb(null),
      SHEET_TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
    };
    const client = createClient(async () => ({
      accessToken: "unused",
      expiresIn: 0,
    }));

    await expect(
      getAuthorizedAccessToken(env, client, "user-1"),
    ).rejects.toBeInstanceOf(SheetConnectionError);
  });

  it("maps an invalid_grant refresh failure to a reconnect prompt", async () => {
    const env = await envWithToken("revoked-refresh");
    const client = createClient(async () => {
      throw new GoogleSheetsError("invalid grant", 400, "invalid_grant");
    });

    await expect(
      getAuthorizedAccessToken(env, client, "user-1"),
    ).rejects.toBeInstanceOf(SheetConnectionError);
  });

  it("rethrows unrelated upstream failures unchanged", async () => {
    const env = await envWithToken("stored-refresh");
    const failure = new GoogleSheetsError("boom", 500, "backendError");
    const client = createClient(async () => {
      throw failure;
    });

    await expect(
      getAuthorizedAccessToken(env, client, "user-1"),
    ).rejects.toBe(failure);
  });
});
