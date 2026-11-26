import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../lib/crypto";
import { SHEET_HEADER_ROW } from "../lib/sheet-flow";
import { GoogleSheetsError } from "../lib/google-sheets";
import type { SheetsEnv } from "../lib/sheet-service";
import {
  describeShelfError,
  invalidateSharedShelfCache,
  loadOwnShelf,
  loadSharedShelves,
  SHARED_SHELF_CACHE_TTL_SECONDS,
  sharedShelfCacheKey,
} from "../lib/shelves";

const KEY = "test-encryption-key";
const header = [...SHEET_HEADER_ROW];
const sharedRow = [
  "9780306406157",
  "Shared Book",
  "Ada",
  "",
  "",
  "",
  "openlibrary",
  "true",
  "false",
  "high",
  "shared",
  "owner@example.com",
  "2026-01-01T00:00:00.000Z",
  "",
  "group-1",
];
const privateRow = [
  "9781861972712",
  "Private Book",
  "Alan",
  "",
  "",
  "",
  "openlibrary",
  "true",
  "false",
  "high",
  "private",
  "owner@example.com",
  "2026-01-02T00:00:00.000Z",
  "",
  "group-1",
];
/** A row explicitly shared but targeted at no group — invisible in group feeds. */
const untaggedSharedRow = [
  "9780140328721",
  "Untagged Book",
  "Bea",
  "",
  "",
  "",
  "openlibrary",
  "true",
  "false",
  "high",
  "shared",
  "owner@example.com",
  "2026-01-03T00:00:00.000Z",
  "",
  "",
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface SheetFixture {
  title: string;
  values: string[][];
}

function spreadsheetIdFromUrl(url: string): string {
  const match = url.match(/\/spreadsheets\/([^/?]+)/);
  return match?.[1] ?? "";
}

/**
 * Global-fetch stub that answers the token endpoint plus per-spreadsheet meta
 * and values reads. A number value means "fail with that HTTP status".
 */
function createFetchStub(routes: Record<string, SheetFixture | number>) {
  let calls = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    calls += 1;
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url.includes("oauth2.googleapis.com/token")) {
      return jsonResponse({ access_token: "access", expires_in: 3600 });
    }
    const id = spreadsheetIdFromUrl(url);
    const route = routes[id];
    if (typeof route === "number") {
      return jsonResponse({ error: { message: "denied", code: route } }, route);
    }
    if (url.includes("/values/")) {
      return jsonResponse({ values: route?.values ?? [] });
    }
    return jsonResponse({
      properties: { title: route?.title ?? null },
      sheets: [{ properties: { title: "Books", sheetId: 0 } }],
    });
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

interface DbOptions {
  ownRow?: Record<string, unknown> | null;
  encryptedToken?: string | null;
  sharedRows?: Record<string, unknown>[];
  /** Active groups the viewer and the owner share (returned for the overlap query). */
  groupIds?: string[];
}

function createDb(options: DbOptions): D1Database {
  const db = {
    prepare(sql: string) {
      const statement = {
        args: [] as unknown[],
        bind(...args: unknown[]) {
          statement.args = args;
          return statement;
        },
        async first() {
          if (sql.includes("SELECT google_refresh_token_encrypted")) {
            const token =
              options.encryptedToken ??
              (options.ownRow?.google_refresh_token_encrypted as
                | string
                | null
                | undefined) ??
              null;
            return token ? { google_refresh_token_encrypted: token } : null;
          }
          if (sql.includes("FROM shelf_configs")) {
            return options.ownRow ?? null;
          }
          return null;
        },
        async all() {
          // `listSharedShelfConfigs` reads shelf_configs; `listCommonActiveGroupIds`
          // reads group_memberships (the discovery query also mentions that table
          // via its overlap EXISTS, so discriminate on shelf_configs first).
          if (sql.includes("FROM shelf_configs")) {
            return { results: options.sharedRows ?? [] };
          }
          if (sql.includes("group_memberships")) {
            return {
              results: (options.groupIds ?? []).map((id) => ({ group_id: id })),
            };
          }
          return { results: [] };
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

function createFakeKv() {
  const store = new Map<string, string>();
  const puts: Array<{ key: string; ttl?: number }> = [];
  const deletes: string[] = [];
  const kv = {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      store.set(key, value);
      puts.push({ key, ttl: opts?.expirationTtl });
    },
    async delete(key: string) {
      store.delete(key);
      deletes.push(key);
    },
  };
  return { kv: kv as unknown as KVNamespace, store, puts, deletes };
}

function baseEnv(overrides: Partial<SheetsEnv> = {}): SheetsEnv {
  return {
    DB: createDb({}),
    GOOGLE_CLIENT_ID: "cid",
    GOOGLE_CLIENT_SECRET: "cs",
    SHEET_TOKEN_ENCRYPTION_KEY: KEY,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadOwnShelf", () => {
  it("reads and maps the user's own shelf", async () => {
    const encrypted = await encryptSecret("refresh-own", KEY);
    const env = baseEnv({
      DB: createDb({
        ownRow: {
          user_id: "user-1",
          spreadsheet_id: "own-sheet",
          sheet_tab_name: "Books",
          default_visibility: "private",
          sheet_visibility: "private",
          allow_incoming_transfers: 0,
          google_refresh_token_encrypted: encrypted,
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      }),
    });
    const { fetchImpl } = createFetchStub({
      "own-sheet": { title: "My Shelf", values: [header, sharedRow, privateRow] },
    });
    vi.stubGlobal("fetch", fetchImpl);

    const view = await loadOwnShelf(env, "user-1");
    expect(view.status).toBe("ok");
    expect(view.title).toBe("My Shelf");
    expect(view.spreadsheetId).toBe("own-sheet");
    expect(view.sheetTabName).toBe("Books");
    expect(view.sheetVisibility).toBe("private");
    // The owner sees every row, including their own private entries.
    expect(view.rows.map((row) => row.title)).toEqual(["Shared Book", "Private Book"]);
  });

  it("surfaces sheet visibility independently of the new-book default (Phase 6)", async () => {
    const encrypted = await encryptSecret("refresh-own", KEY);
    const env = baseEnv({
      DB: createDb({
        ownRow: {
          user_id: "user-1",
          spreadsheet_id: "own-sheet",
          sheet_tab_name: "Books",
          default_visibility: "shared",
          sheet_visibility: "private",
          allow_incoming_transfers: 0,
          google_refresh_token_encrypted: encrypted,
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      }),
    });
    const { fetchImpl } = createFetchStub({
      "own-sheet": { title: "My Shelf", values: [header] },
    });
    vi.stubGlobal("fetch", fetchImpl);

    const view = await loadOwnShelf(env, "user-1");
    // A "shared" new-book default must NOT make the whole sheet shared.
    expect(view.sheetVisibility).toBe("private");
  });

  it("reports not_connected when no refresh token is stored", async () => {
    const env = baseEnv({
      DB: createDb({
        ownRow: {
          user_id: "user-1",
          spreadsheet_id: "own-sheet",
          sheet_tab_name: "Books",
          default_visibility: "private",
          sheet_visibility: "private",
          allow_incoming_transfers: 0,
          google_refresh_token_encrypted: null,
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      }),
    });

    const view = await loadOwnShelf(env, "user-1");
    expect(view.status).toBe("not_connected");
    expect(view.rows).toEqual([]);
  });

  it("reports unlinked when connected but no spreadsheet is bound", async () => {
    const encrypted = await encryptSecret("refresh-own", KEY);
    const env = baseEnv({
      DB: createDb({
        ownRow: {
          user_id: "user-1",
          spreadsheet_id: null,
          sheet_tab_name: "Books",
          default_visibility: "private",
          sheet_visibility: "private",
          allow_incoming_transfers: 0,
          google_refresh_token_encrypted: encrypted,
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      }),
    });

    const view = await loadOwnShelf(env, "user-1");
    expect(view.status).toBe("unlinked");
    expect(view.spreadsheetId).toBeNull();
  });

  it("isolates a read failure into an error status with guidance", async () => {
    const encrypted = await encryptSecret("refresh-own", KEY);
    const env = baseEnv({
      DB: createDb({
        ownRow: {
          user_id: "user-1",
          spreadsheet_id: "own-sheet",
          sheet_tab_name: "Books",
          default_visibility: "private",
          sheet_visibility: "private",
          allow_incoming_transfers: 0,
          google_refresh_token_encrypted: encrypted,
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      }),
    });
    // 403 → the user must reconnect / re-pick the file.
    const { fetchImpl } = createFetchStub({ "own-sheet": 403 });
    vi.stubGlobal("fetch", fetchImpl);

    const view = await loadOwnShelf(env, "user-1");
    expect(view.status).toBe("error");
    expect(view.message).toMatch(/lost access/i);
  });
});

describe("loadSharedShelves", () => {
  const sharedRowConfig = {
    user_id: "owner-1",
    email: "owner@example.com",
    name: "Owner One",
    spreadsheet_id: "shared-sheet",
    sheet_tab_name: "Books",
  };

  async function envWithShared(overrides: Partial<SheetsEnv> = {}) {
    const encrypted = await encryptSecret("refresh-owner", KEY);
    return baseEnv({
      DB: createDb({
        sharedRows: [sharedRowConfig],
        encryptedToken: encrypted,
        groupIds: ["group-1"],
      }),
      ...overrides,
    });
  }

  it("reads a shared shelf and filters out private rows under the shared groups", async () => {
    const env = await envWithShared();
    const { fetchImpl } = createFetchStub({
      "shared-sheet": {
        title: "Owner Shelf",
        values: [header, sharedRow, privateRow],
      },
    });
    vi.stubGlobal("fetch", fetchImpl);

    const shelves = await loadSharedShelves(env, "viewer-1");
    expect(shelves).toHaveLength(1);
    const shelf = shelves[0];
    expect(shelf?.status).toBe("ok");
    expect(shelf?.ownerEmail).toBe("owner@example.com");
    expect(shelf?.title).toBe("Owner Shelf");
    // The common active group the viewer and owner share, used for row filtering.
    expect(shelf?.groupIds).toEqual(["group-1"]);
    expect(shelf?.rows.map((row) => row.title)).toEqual(["Shared Book"]);
  });

  it("hides a shared row that targets no group (Level 3)", async () => {
    const env = await envWithShared();
    const { fetchImpl } = createFetchStub({
      "shared-sheet": {
        title: "Owner Shelf",
        values: [header, untaggedSharedRow],
      },
    });
    vi.stubGlobal("fetch", fetchImpl);

    const shelves = await loadSharedShelves(env, "viewer-1");
    expect(shelves[0]?.groupIds).toEqual(["group-1"]);
    expect(shelves[0]?.rows).toEqual([]);
  });

  it("hides a shared row whose group is not shared with the viewer (Level 3)", async () => {
    const env = await envWithShared();
    const foreignRow = [...sharedRow];
    foreignRow[14] = "group-other";
    const { fetchImpl } = createFetchStub({
      "shared-sheet": { title: "Owner Shelf", values: [header, foreignRow] },
    });
    vi.stubGlobal("fetch", fetchImpl);

    const shelves = await loadSharedShelves(env, "viewer-1");
    expect(shelves[0]?.rows).toEqual([]);
  });

  it("caches a read in KV and serves the next call from cache", async () => {
    const { kv, puts } = createFakeKv();
    const env = await envWithShared({ SHELF_CACHE: kv });
    const { fetchImpl, calls } = createFetchStub({
      "shared-sheet": { title: "Owner Shelf", values: [header, sharedRow] },
    });
    vi.stubGlobal("fetch", fetchImpl);

    await loadSharedShelves(env, "viewer-1");
    const afterFirst = calls();
    await loadSharedShelves(env, "viewer-1");

    // The token + meta + values reads happened once; the second load is cached.
    expect(calls()).toBe(afterFirst);
    expect(puts[0]?.key).toBe(
      sharedShelfCacheKey({
        userId: "owner-1",
        spreadsheetId: "shared-sheet",
        sheetTabName: "Books",
      }),
    );
    expect(puts[0]?.ttl).toBe(SHARED_SHELF_CACHE_TTL_SECONDS);
  });

  it("falls back to a live read when no KV binding is present", async () => {
    const env = await envWithShared();
    const { fetchImpl } = createFetchStub({
      "shared-sheet": { title: "Owner Shelf", values: [header, sharedRow] },
    });
    vi.stubGlobal("fetch", fetchImpl);

    const shelves = await loadSharedShelves(env, "viewer-1");
    expect(shelves[0]?.status).toBe("ok");
  });

  it("isolates one owner's failure without failing the whole dashboard", async () => {
    const encrypted = await encryptSecret("refresh-a", KEY);
    const env = baseEnv({
      DB: createDb({
        sharedRows: [
          sharedRowConfig,
          {
            user_id: "owner-2",
            email: "revoked@example.com",
            name: "Revoked",
            spreadsheet_id: "revoked-sheet",
            sheet_tab_name: "Books",
          },
        ],
        encryptedToken: encrypted,
        groupIds: ["group-1"],
      }),
    });
    const { fetchImpl } = createFetchStub({
      "shared-sheet": { title: "Owner Shelf", values: [header, sharedRow] },
      "revoked-sheet": 403,
    });
    vi.stubGlobal("fetch", fetchImpl);

    const shelves = await loadSharedShelves(env, "viewer-1");
    expect(shelves.map((shelf) => shelf.status)).toEqual(["ok", "error"]);
    expect(shelves[1]?.message).toMatch(/lost access/i);
    expect(shelves[0]?.rows).toHaveLength(1);
  });
});

describe("invalidateSharedShelfCache", () => {
  it("drops the cached shared read for the owner's sheet", async () => {
    const { kv, store, deletes } = createFakeKv();
    const env = baseEnv({ SHELF_CACHE: kv });
    const key = sharedShelfCacheKey({
      userId: "owner-1",
      spreadsheetId: "shared-sheet",
      sheetTabName: "Books",
    });
    store.set(key, JSON.stringify({ title: null, rows: [] }));

    await invalidateSharedShelfCache(env, {
      userId: "owner-1",
      spreadsheetId: "shared-sheet",
      sheetTabName: "Books",
    });

    expect(store.has(key)).toBe(false);
    expect(deletes).toEqual([key]);
  });

  it("is a no-op without a KV binding or a bound sheet", async () => {
    await expect(
      invalidateSharedShelfCache(baseEnv(), {
        userId: "owner-1",
        spreadsheetId: "shared-sheet",
        sheetTabName: "Books",
      }),
    ).resolves.toBeUndefined();

    const { kv, deletes } = createFakeKv();
    await invalidateSharedShelfCache(baseEnv({ SHELF_CACHE: kv }), {
      userId: "owner-1",
      spreadsheetId: null,
      sheetTabName: "Books",
    });
    expect(deletes).toEqual([]);
  });
});

describe("describeShelfError", () => {
  it("maps a revoked connection to a reconnect message", () => {
    expect(describeShelfError(new GoogleSheetsError("x", 403))).toMatch(
      /lost access/i,
    );
  });

  it("maps rate limiting to a retry message", () => {
    expect(describeShelfError(new GoogleSheetsError("x", 429))).toMatch(
      /rate limiting/i,
    );
  });

  it("falls back to a generic message for unknown errors", () => {
    expect(describeShelfError(new Error("boom"))).toMatch(/went wrong/i);
  });
});
