import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHEET_TAB_NAME,
  getEncryptedRefreshToken,
  getShelfConfig,
  getTransferTarget,
  listSharedShelfConfigs,
  listTransferTargets,
  upsertShelfConfig,
} from "../lib/shelf-configs";

interface RecordedStatement {
  sql: string;
  args: unknown[];
}

/** Minimal D1 double that records prepared statements and returns one row. */
function createFakeDb(firstRow: unknown) {
  const statements: RecordedStatement[] = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        sql,
        args: [] as unknown[],
        bind(...args: unknown[]) {
          statement.args = args;
          return statement;
        },
        async run() {
          statements.push({ sql, args: statement.args });
          return { success: true };
        },
        async first() {
          statements.push({ sql, args: statement.args });
          return firstRow;
        },
      };
      return statement;
    },
  };
  return { db: db as unknown as D1Database, statements };
}

const sampleRow = {
  user_id: "user-1",
  spreadsheet_id: "sheet-1",
  sheet_tab_name: "Books",
  default_visibility: "shared",
  sheet_visibility: "shared",
  allow_incoming_transfers: 1,
  google_refresh_token_encrypted: "v1.iv.ciphertext",
  updated_at: "2026-01-01T00:00:00.000Z",
};

describe("getShelfConfig", () => {
  it("maps a stored row into a typed config", async () => {
    const { db } = createFakeDb(sampleRow);
    const config = await getShelfConfig(db, "user-1");
    expect(config).toEqual({
      userId: "user-1",
      spreadsheetId: "sheet-1",
      sheetTabName: "Books",
      defaultVisibility: "shared",
      sheetVisibility: "shared",
      allowIncomingTransfers: true,
      hasRefreshToken: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("returns null when the user has no configuration", async () => {
    const { db } = createFakeDb(null);
    await expect(getShelfConfig(db, "user-1")).resolves.toBeNull();
  });

  it("coerces unknown visibility and missing tokens to safe defaults", async () => {
    const { db } = createFakeDb({
      ...sampleRow,
      default_visibility: "weird",
      sheet_visibility: "weird",
      allow_incoming_transfers: 0,
      google_refresh_token_encrypted: null,
    });
    const config = await getShelfConfig(db, "user-1");
    expect(config?.defaultVisibility).toBe("private");
    expect(config?.sheetVisibility).toBe("private");
    expect(config?.allowIncomingTransfers).toBe(false);
    expect(config?.hasRefreshToken).toBe(false);
  });
});

describe("getEncryptedRefreshToken", () => {
  it("returns the stored ciphertext", async () => {
    const { db } = createFakeDb({ google_refresh_token_encrypted: "v1.a.b" });
    await expect(getEncryptedRefreshToken(db, "user-1")).resolves.toBe("v1.a.b");
  });

  it("treats empty strings and missing rows as disconnected", async () => {
    const empty = createFakeDb({ google_refresh_token_encrypted: "" });
    await expect(
      getEncryptedRefreshToken(empty.db, "user-1"),
    ).resolves.toBeNull();

    const missing = createFakeDb(null);
    await expect(
      getEncryptedRefreshToken(missing.db, "user-1"),
    ).resolves.toBeNull();
  });
});

describe("upsertShelfConfig", () => {
  it("inserts column defaults, then patches only supplied fields", async () => {
    const { db, statements } = createFakeDb(sampleRow);
    const config = await upsertShelfConfig(db, "user-1", {
      defaultVisibility: "private",
      allowIncomingTransfers: true,
    });

    expect(statements[0]?.sql).toContain("INSERT OR IGNORE INTO shelf_configs");
    expect(statements[0]?.sql).toContain("sheet_visibility");
    expect(statements[0]?.args).toContain(DEFAULT_SHEET_TAB_NAME);
    expect(statements[1]?.sql).toContain("UPDATE shelf_configs SET");
    expect(statements[1]?.sql).toContain("default_visibility = ?");
    expect(statements[1]?.sql).toContain("allow_incoming_transfers = ?");
    expect(statements[1]?.sql).toContain("updated_at = ?");
    // Booleans are persisted as 0/1 integers.
    expect(statements[1]?.args).toContain(1);
    expect(statements[1]?.args).toContain("user-1");
    expect(config.userId).toBe("user-1");
  });

  it("patches sheet visibility without touching the new-book default (Phase 6)", async () => {
    const { db, statements } = createFakeDb(sampleRow);
    await upsertShelfConfig(db, "user-1", { sheetVisibility: "private" });

    expect(statements[1]?.sql).toContain("sheet_visibility = ?");
    // The two settings are decoupled: changing sheet visibility must not write
    // the new-book default column, and vice versa.
    expect(statements[1]?.sql).not.toContain("default_visibility = ?");
    expect(statements[1]?.args).toContain("private");
  });

  it("stores an encrypted token without exporting it on the config", async () => {
    const { db, statements } = createFakeDb(sampleRow);
    const config = await upsertShelfConfig(db, "user-1", {
      googleRefreshTokenEncrypted: "v1.iv.ciphertext",
    });
    expect(statements[1]?.sql).toContain("google_refresh_token_encrypted = ?");
    expect(statements[1]?.args).toContain("v1.iv.ciphertext");
    expect(config.hasRefreshToken).toBe(true);
    expect(Object.keys(config)).not.toContain("googleRefreshTokenEncrypted");
  });

  it("only updates the timestamp when the patch is empty", async () => {
    const { db, statements } = createFakeDb(sampleRow);
    await upsertShelfConfig(db, "user-1");
    expect(statements[1]?.sql).toBe(
      "UPDATE shelf_configs SET updated_at = ? WHERE user_id = ?",
    );
  });
});

/** D1 double whose `all()` returns canned joined rows and records the SQL. */
function createAllDb(rows: unknown[]) {
  const statements: RecordedStatement[] = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        args: [] as unknown[],
        bind(...args: unknown[]) {
          statement.args = args;
          return statement;
        },
        async all() {
          statements.push({ sql, args: statement.args });
          return { results: rows };
        },
      };
      return statement;
    },
  };
  return { db: db as unknown as D1Database, statements };
}

describe("listSharedShelfConfigs", () => {
  it("maps joined rows into owner-labelled shared configs", async () => {
    const { db } = createAllDb([
      {
        user_id: "owner-1",
        email: "owner@example.com",
        name: "Owner One",
        spreadsheet_id: "shared-sheet",
        sheet_tab_name: "Books",
      },
    ]);

    const configs = await listSharedShelfConfigs(db, "viewer-1");
    expect(configs).toEqual([
      {
        userId: "owner-1",
        ownerEmail: "owner@example.com",
        ownerName: "Owner One",
        spreadsheetId: "shared-sheet",
        sheetTabName: "Books",
      },
    ]);
  });

  it("excludes the viewer and unbound/private shelves, scoped to shared active groups", async () => {
    const { db, statements } = createAllDb([]);
    await listSharedShelfConfigs(db, "viewer-1");

    const sql = statements[0]?.sql ?? "";
    expect(sql).toContain("sc.spreadsheet_id IS NOT NULL");
    // Phase 6 Level 2: discovery keys off the dedicated sheet-visibility flag,
    // NOT the new-book default.
    expect(sql).toContain("sc.sheet_visibility = 'shared'");
    expect(sql).not.toContain("sc.default_visibility = 'shared'");
    expect(sql).toContain("sc.google_refresh_token_encrypted IS NOT NULL");
    expect(sql).toContain("sc.user_id != ?");
    // Phase 5 Level 1: a shared shelf is discoverable only among active
    // co-members of at least one group.
    expect(sql).toContain("group_memberships me");
    expect(sql).toContain("group_memberships them");
    expect(sql).toContain("me.status = 'active'");
    expect(sql).toContain("them.status = 'active'");
    // The viewer id is bound twice — self-exclusion + the group-overlap EXISTS.
    expect(statements[0]?.args).toEqual(["viewer-1", "viewer-1"]);
  });

  it("returns an empty list when nothing is shared", async () => {
    const { db } = createAllDb([]);
    await expect(listSharedShelfConfigs(db, "viewer-1")).resolves.toEqual([]);
  });
});

describe("listTransferTargets", () => {
  it("maps eligible recipients to picker options", async () => {
    const { db } = createAllDb([
      { user_id: "to-1", email: "to@example.com", name: "Target One" },
    ]);

    await expect(listTransferTargets(db, "sender-1")).resolves.toEqual([
      { userId: "to-1", email: "to@example.com", name: "Target One" },
    ]);
  });

  it("applies the eligibility predicate, excludes the sender, and requires a shared group", async () => {
    const { db, statements } = createAllDb([]);
    await listTransferTargets(db, "sender-1");

    const sql = statements[0]?.sql ?? "";
    expect(sql).toContain("sc.spreadsheet_id IS NOT NULL");
    expect(sql).toContain("sc.sheet_tab_name IS NOT NULL");
    expect(sql).toContain("sc.allow_incoming_transfers = 1");
    expect(sql).toContain("sc.google_refresh_token_encrypted IS NOT NULL");
    expect(sql).toContain("sc.user_id != ?");
    expect(sql).toContain("group_memberships me");
    // The sender id is bound twice — self-exclusion + the group-overlap EXISTS.
    expect(statements[0]?.args).toEqual(["sender-1", "sender-1"]);
  });
});

describe("getTransferTarget", () => {
  it("returns the recipient's sheet location and visibility", async () => {
    const { db } = createFakeDb({
      user_id: "to-1",
      email: "to@example.com",
      name: "Target One",
      spreadsheet_id: "dst-sheet",
      sheet_tab_name: "Books",
      default_visibility: "shared",
    });

    await expect(getTransferTarget(db, "to-1", "sender-1")).resolves.toEqual({
      userId: "to-1",
      email: "to@example.com",
      name: "Target One",
      spreadsheetId: "dst-sheet",
      sheetTabName: "Books",
      defaultVisibility: "shared",
    });
  });

  it("returns null when no eligible row matches", async () => {
    const { db } = createFakeDb(null);
    await expect(getTransferTarget(db, "nobody", "sender-1")).resolves.toBeNull();
  });

  it("resolves the requested recipient (not another user) within a shared group", async () => {
    const { db, statements } = createFakeDb(null);
    await getTransferTarget(db, "to-1", "sender-1");

    const sql = statements[0]?.sql ?? "";
    // Must match the requested user; the picker's `!= ?` self-exclusion must not
    // leak into the single-target lookup (it would resolve a different user).
    expect(sql).toContain("sc.user_id = ?");
    expect(sql).not.toContain("sc.user_id != ?");
    // Phase 5 Level 1: the recipient must share an active group with the sender.
    expect(sql).toContain("group_memberships me");
    expect(sql).toContain("them.user_id = sc.user_id");
    // Binds the target id first, then the sender id for the group-overlap EXISTS.
    expect(statements[0]?.args).toEqual(["to-1", "sender-1"]);
  });
});
