import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../lib/crypto";
import type { SheetsEnv } from "../lib/sheet-service";
import { transferBook, type TransferSuccess } from "../lib/transfers";

const KEY = "test-encryption-key";

const sourceCells = [
  "9780306406157", // isbn13
  "Dune", // title
  "Frank Herbert", // authors
  "Chilton", // publisher
  "1965", // publishedYear
  "A desert planet.", // summary
  "openlibrary", // source
  "true", // verified
  "false", // enriched
  "high", // confidence
  "private", // visibility
  "from@example.com", // ownerEmail
  "2026-01-01T00:00:00.000Z", // addedAt
  "", // transferredFrom
  "group-1,group-2", // groups (sender's targets)
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface StubOptions {
  senderValues?: string[][];
  senderSheetId?: number | null;
  failAppend?: number;
  failBatchUpdate?: number;
  failMeta?: number;
  /** Fail the Nth token exchange (1 = sender, 2 = recipient). */
  failTokenCall?: number;
}

/** Fetch stub for the token endpoint, row read, append, meta, and batchUpdate. */
function createFetchStub(options: StubOptions) {
  const calls: string[] = [];
  const bodies: Record<string, unknown> = {};
  let tokenCalls = 0;

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    if (url.includes("oauth2.googleapis.com/token")) {
      tokenCalls += 1;
      if (options.failTokenCall === tokenCalls) {
        return jsonResponse({ error: "invalid_grant" }, 400);
      }
      return jsonResponse({ access_token: `access-${tokenCalls}`, expires_in: 3600 });
    }
    if (url.includes(":batchUpdate")) {
      calls.push("batchUpdate");
      bodies.batchUpdate = JSON.parse(String(init?.body ?? "{}"));
      if (options.failBatchUpdate) {
        return jsonResponse({ error: { message: "denied" } }, options.failBatchUpdate);
      }
      return jsonResponse({});
    }
    if (url.includes(":append")) {
      calls.push("append");
      bodies.append = JSON.parse(String(init?.body ?? "{}"));
      if (options.failAppend) {
        return jsonResponse({ error: { message: "denied" } }, options.failAppend);
      }
      return jsonResponse({ updates: {} });
    }
    if (url.includes("/values/")) {
      calls.push("values");
      return jsonResponse({ values: options.senderValues ?? [] });
    }
    calls.push("meta");
    if (options.failMeta) {
      return jsonResponse({ error: { message: "denied" } }, options.failMeta);
    }
    return jsonResponse({
      properties: { title: "Sender Shelf" },
      sheets: [{ properties: { title: "Books", sheetId: options.senderSheetId ?? 0 } }],
    });
  }) as typeof fetch;

  return { fetchImpl, calls, bodies, tokenCalls: () => tokenCalls };
}

interface DbOptions {
  senderRow?: Record<string, unknown> | null;
  targetRow?: Record<string, unknown> | null;
  tokens?: Record<string, string | null>;
}

function createDb(options: DbOptions) {
  const runs: Array<{ sql: string; args: unknown[] }> = [];
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
            const userId = String(statement.args[0]);
            const token = options.tokens?.[userId] ?? null;
            return token ? { google_refresh_token_encrypted: token } : null;
          }
          if (sql.includes('JOIN "user"')) {
            return options.targetRow ?? null;
          }
          if (sql.includes("FROM shelf_configs")) {
            return options.senderRow ?? null;
          }
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          runs.push({ sql, args: statement.args });
          return { success: true };
        },
      };
      return statement;
    },
  };
  return { db: db as unknown as D1Database, runs };
}

function auditRun(runs: Array<{ sql: string; args: unknown[] }>) {
  return runs.find((run) => run.sql.includes("INSERT INTO ownership_transfers"));
}

/** Env whose DB run log we can assert on. */
async function envWithRuns(options: DbOptions) {
  const senderToken = await encryptSecret("refresh-sender", KEY);
  const targetToken = await encryptSecret("refresh-target", KEY);
  const senderRow =
    options.senderRow !== undefined
      ? options.senderRow
      : {
          user_id: "sender",
          spreadsheet_id: "src-sheet",
          sheet_tab_name: "Books",
          default_visibility: "private",
          allow_incoming_transfers: 0,
          google_refresh_token_encrypted: senderToken,
          updated_at: "2026-01-01T00:00:00.000Z",
        };
  const targetRow =
    options.targetRow !== undefined
      ? options.targetRow
      : {
          user_id: "target",
          email: "to@example.com",
          name: "Target Reader",
          spreadsheet_id: "dst-sheet",
          sheet_tab_name: "Books",
          default_visibility: "shared",
        };
  const { db, runs } = createDb({
    senderRow,
    targetRow,
    tokens: { sender: senderToken, target: targetToken },
  });
  const env: SheetsEnv = {
    DB: db,
    GOOGLE_CLIENT_ID: "cid",
    GOOGLE_CLIENT_SECRET: "cs",
    SHEET_TOKEN_ENCRYPTION_KEY: KEY,
  };
  return { env, runs };
}

const input = {
  fromUserId: "sender",
  fromEmail: "from@example.com",
  rowIndex: 2,
  targetUserId: "target",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("transferBook", () => {
  it("appends to the recipient, then removes the sender's row", async () => {
    const { env, runs } = await envWithRuns({});
    const { fetchImpl, calls, bodies } = createFetchStub({
      senderValues: [sourceCells],
      senderSheetId: 0,
    });
    vi.stubGlobal("fetch", fetchImpl);

    const result = await transferBook(env, input);
    expect(result instanceof Response).toBe(false);
    const success = result as TransferSuccess;
    expect(success.ok).toBe(true);
    expect(success.removedFromSender).toBe(true);
    expect(success.warning).toBeNull();
    expect(success.from.email).toBe("from@example.com");
    expect(success.to.email).toBe("to@example.com");

    // The append happens before the sender's row is removed.
    expect(calls).toEqual(["values", "append", "meta", "batchUpdate"]);

    // Canonical columns are remapped: new owner, provenance, recipient default.
    const appended = (bodies.append as { values: string[][] }).values[0];
    expect(appended).toBeDefined();
    expect(appended?.[0]).toBe("9780306406157");
    expect(appended?.[1]).toBe("Dune");
    expect(appended?.[10]).toBe("shared");
    expect(appended?.[11]).toBe("to@example.com");
    expect(appended?.[13]).toBe("from@example.com");
    // Group tags belong to the sender's target list; the recipient re-tags later.
    expect(appended?.[14]).toBe("");

    const audit = auditRun(runs);
    expect(audit?.args).toContain("completed");
    expect(audit?.args).toContain("from@example.com");
    expect(audit?.args).toContain("to@example.com");
  });

  it("leaves the sender's row untouched when the append fails", async () => {
    const { env, runs } = await envWithRuns({});
    const { fetchImpl, calls } = createFetchStub({
      senderValues: [sourceCells],
      failAppend: 502,
    });
    vi.stubGlobal("fetch", fetchImpl);

    const result = await transferBook(env, input);
    expect(result instanceof Response).toBe(true);
    expect((result as Response).status).toBe(502);
    // The sender's row is never removed after a failed append.
    expect(calls).not.toContain("batchUpdate");

    const audit = auditRun(runs);
    expect(audit?.args).toContain("failed");
    expect(audit?.args.at(-1)).toBeNull();
  });

  it("keeps the book (and warns) when the sender row cannot be removed", async () => {
    const { env, runs } = await envWithRuns({});
    const { fetchImpl, calls } = createFetchStub({
      senderValues: [sourceCells],
      failMeta: 403,
    });
    vi.stubGlobal("fetch", fetchImpl);

    const result = await transferBook(env, input);
    const success = result as TransferSuccess;
    expect(success.removedFromSender).toBe(false);
    expect(success.warning).toMatch(/could not be removed/i);
    expect(calls).toContain("append");
    expect(calls).not.toContain("batchUpdate");

    const audit = auditRun(runs);
    expect(audit?.args).toContain("completed");
    expect(audit?.args).toContain(success.warning);
  });

  it("rejects an ineligible recipient before touching any sheet", async () => {
    const { env, runs } = await envWithRuns({ targetRow: null });
    const { fetchImpl, calls } = createFetchStub({ senderValues: [sourceCells] });
    vi.stubGlobal("fetch", fetchImpl);

    const result = await transferBook(env, input);
    expect(result instanceof Response).toBe(true);
    const response = result as Response;
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("TARGET_NOT_ELIGIBLE");
    expect(calls).not.toContain("append");
    expect(auditRun(runs)).toBeUndefined();
  });

  it("rejects a transfer to the sender", async () => {
    const { env } = await envWithRuns({});
    const result = await transferBook(env, {
      ...input,
      targetUserId: "sender",
    });
    expect(result instanceof Response).toBe(true);
    expect((result as Response).status).toBe(400);
  });

  it("reports a missing source row without any write", async () => {
    const { env, runs } = await envWithRuns({});
    const { fetchImpl, calls } = createFetchStub({ senderValues: [] });
    vi.stubGlobal("fetch", fetchImpl);

    const result = await transferBook(env, input);
    expect(result instanceof Response).toBe(true);
    expect((result as Response).status).toBe(404);
    expect(calls).not.toContain("append");
    expect(auditRun(runs)).toBeUndefined();
  });

  it("surfaces a recipient re-auth requirement as not eligible", async () => {
    const { env, runs } = await envWithRuns({});
    const { fetchImpl, calls } = createFetchStub({
      senderValues: [sourceCells],
      failTokenCall: 2,
    });
    vi.stubGlobal("fetch", fetchImpl);

    const result = await transferBook(env, input);
    expect(result instanceof Response).toBe(true);
    const response = result as Response;
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("TARGET_NOT_ELIGIBLE");
    expect(calls).not.toContain("append");
    expect(auditRun(runs)).toBeUndefined();
  });

  it("reports a disconnected sender", async () => {
    const { env } = await envWithRuns({ senderRow: null });
    const result = await transferBook(env, input);
    expect(result instanceof Response).toBe(true);
    const body = (await (result as Response).json()) as { error: string };
    expect(body.error).toBe("SHEET_NOT_CONNECTED");
  });
});
