import { describe, expect, it } from "vitest";
import {
  addCredit,
  CREDIT_ACTION_BATCH_BOOK_SUMMARY,
  CREDIT_ACTION_BOOK_SUMMARY,
  CREDIT_ACTION_BOOK_TITLE_IMAGE,
  DEFAULT_CREDIT_RATES,
  formatCredit,
  getCreditBalance,
  getCreditSummary,
  getPaymentByReference,
  markPaymentStatus,
  rateForAction,
  recordPendingPayment,
  recordUsage,
  resolveCreditRates,
} from "../lib/credits";

interface RecordedStatement {
  sql: string;
  args: unknown[];
}

/** Minimal D1 double that records prepared statements and returns canned rows. */
function createFakeDb(
  options: {
    first?: unknown;
    all?: unknown[];
    changes?: number;
  } = {},
) {
  const statements: RecordedStatement[] = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        args: [] as unknown[],
        bind(...args: unknown[]) {
          statement.args = args;
          return statement;
        },
        async run() {
          statements.push({ sql, args: statement.args });
          return { success: true, meta: { changes: options.changes ?? 1 } };
        },
        async first() {
          statements.push({ sql, args: statement.args });
          return options.first ?? null;
        },
        async all() {
          statements.push({ sql, args: statement.args });
          return { results: options.all ?? [] };
        },
      };
      return statement;
    },
  };
  return { db: db as unknown as D1Database, statements };
}

describe("resolveCreditRates", () => {
  it("uses the documented defaults when no binding is set", () => {
    expect(resolveCreditRates()).toEqual({
      bookSummary: 0.00001,
      batchBookSummary: 0.0001,
      bookTitleImage: 0.00005,
    });
    expect(DEFAULT_CREDIT_RATES.bookSummary).toBe(0.00001);
    expect(DEFAULT_CREDIT_RATES.batchBookSummary).toBe(0.0001);
    expect(DEFAULT_CREDIT_RATES.bookTitleImage).toBe(0.00005);
  });

  it("reads overrides from the environment bindings", () => {
    expect(
      resolveCreditRates({
        CREDIT_RATE_BOOK_SUMMARY: "0.001",
        CREDIT_RATE_BATCH_BOOK_SUMMARY: "0.002",
        CREDIT_RATE_BOOK_TITLE_IMAGE: "0.003",
      }),
    ).toEqual({ bookSummary: 0.001, batchBookSummary: 0.002, bookTitleImage: 0.003 });
  });

  it("falls back per-field for blank, invalid, or negative bindings", () => {
    expect(
      resolveCreditRates({
        CREDIT_RATE_BOOK_SUMMARY: "",
        CREDIT_RATE_BATCH_BOOK_SUMMARY: "abc",
        CREDIT_RATE_BOOK_TITLE_IMAGE: "-1",
      }),
    ).toEqual(DEFAULT_CREDIT_RATES);
  });
});

describe("rateForAction", () => {
  it("maps each usage action to its configured rate", () => {
    const rates = { bookSummary: 1, batchBookSummary: 2, bookTitleImage: 3 };
    expect(rateForAction(rates, CREDIT_ACTION_BOOK_SUMMARY)).toBe(1);
    expect(rateForAction(rates, CREDIT_ACTION_BATCH_BOOK_SUMMARY)).toBe(2);
    expect(rateForAction(rates, CREDIT_ACTION_BOOK_TITLE_IMAGE)).toBe(3);
  });
});

describe("formatCredit", () => {
  it("always shows at least two decimals", () => {
    expect(formatCredit(0.99)).toBe("0.99");
    expect(formatCredit(0)).toBe("0.00");
    expect(formatCredit(1)).toBe("1.00");
    expect(formatCredit(0.00001)).toBe("0.00001");
  });
});

describe("getCreditBalance", () => {
  it("sums the signed ledger", async () => {
    const { db, statements } = createFakeDb({ first: { total: 0.5 } });
    await expect(getCreditBalance(db, "u1")).resolves.toBe(0.5);
    expect(statements[0]?.sql).toContain("SUM(amount)");
    expect(statements[0]?.args).toEqual(["u1"]);
  });

  it("treats a missing sum as zero", async () => {
    const { db } = createFakeDb({ first: { total: null } });
    await expect(getCreditBalance(db, "u1")).resolves.toBe(0);
  });
});

describe("getCreditSummary", () => {
  it("aggregates billing totals and per-action usage", async () => {
    const statements: string[] = [];
    const db = {
      prepare(sql: string) {
        statements.push(sql);
        return {
          bind() {
            return this;
          },
          async first() {
            return { added: 0.99, used: 0.00003 };
          },
          async all() {
            return {
              results: [
                { action: CREDIT_ACTION_BOOK_SUMMARY, total: 0.00002 },
                { action: CREDIT_ACTION_BOOK_TITLE_IMAGE, total: 0.00001 },
              ],
            };
          },
        };
      },
    } as unknown as D1Database;

    await expect(getCreditSummary(db, "u1")).resolves.toEqual({
      balance: 0.98997,
      totalAdded: 0.99,
      totalUsed: 0.00003,
      usageByAction: [
        { action: CREDIT_ACTION_BOOK_SUMMARY, label: "Book summary", total: 0.00002 },
        {
          action: CREDIT_ACTION_BOOK_TITLE_IMAGE,
          label: "Book title / cover image",
          total: 0.00001,
        },
      ],
    });
    expect(statements.some((sql) => sql.includes("kind = 'topup'"))).toBe(true);
    expect(statements.some((sql) => sql.includes("GROUP BY action"))).toBe(true);
  });
});

describe("addCredit", () => {
  it("inserts a positive ledger row and reports the new balance", async () => {
    const { db, statements } = createFakeDb({ first: { total: 0.99 }, changes: 1 });
    const result = await addCredit(db, "u1", {
      amount: 0.99,
      reference: "llmunlock:u1:x",
    });

    expect(result).toEqual({ credited: true, balance: 0.99 });
    expect(statements[0]?.sql).toContain("INSERT OR IGNORE INTO credit_ledger");
    expect(statements[0]?.args).toContain(0.99);
    expect(statements[0]?.args).toContain("llmunlock:u1:x");
  });

  it("is idempotent on a replayed reference (no new row)", async () => {
    const { db } = createFakeDb({ first: { total: 0.99 }, changes: 0 });
    const result = await addCredit(db, "u1", { amount: 0.99, reference: "ref" });
    expect(result.credited).toBe(false);
    expect(result.balance).toBe(0.99);
  });
});

describe("recordUsage", () => {
  it("records a negative usage entry and returns the balance", async () => {
    const { db, statements } = createFakeDb({
      first: { total: 0.98999 },
      changes: 1,
    });
    const balance = await recordUsage(db, "u1", {
      action: CREDIT_ACTION_BOOK_SUMMARY,
      amount: 0.00001,
    });

    expect(balance).toBe(0.98999);
    expect(statements[0]?.sql).toContain("INSERT INTO credit_ledger");
    expect(statements[0]?.args).toContain(-0.00001);
  });

  it("writes no row when the configured rate is zero", async () => {
    const { db, statements } = createFakeDb({ first: { total: 0 } });
    const balance = await recordUsage(db, "u1", {
      action: CREDIT_ACTION_BOOK_SUMMARY,
      amount: 0,
    });

    expect(balance).toBe(0);
    expect(statements.some((s) => s.sql.includes("INSERT"))).toBe(false);
  });
});

describe("credit_payments accessors", () => {
  it("persists a pending payment guarded by the unique reference", async () => {
    const { db, statements } = createFakeDb();
    await recordPendingPayment(db, {
      id: "pr_1",
      userId: "u1",
      reference: "ref",
      amount: 0.99,
      currency: "USD",
    });

    expect(statements[0]?.sql).toContain("INSERT OR IGNORE INTO credit_payments");
    expect(statements[0]?.args).toEqual([
      "pr_1",
      "u1",
      "ref",
      0.99,
      "USD",
      expect.any(String),
      expect.any(String),
    ]);
  });

  it("maps a stored payment row into the typed shape", async () => {
    const { db } = createFakeDb({
      first: {
        id: "pr_1",
        user_id: "u1",
        reference: "ref",
        amount: 0.99,
        currency: "USD",
        status: "pending",
        credited_at: null,
        created_at: "t0",
        updated_at: "t1",
      },
    });

    await expect(getPaymentByReference(db, "ref")).resolves.toEqual({
      id: "pr_1",
      userId: "u1",
      reference: "ref",
      amount: 0.99,
      currency: "USD",
      status: "pending",
      creditedAt: null,
      createdAt: "t0",
      updatedAt: "t1",
    });
  });

  it("returns null when no payment matches", async () => {
    const { db } = createFakeDb({ first: null });
    await expect(getPaymentByReference(db, "nope")).resolves.toBeNull();
  });

  it("updates status and stamps credited_at via COALESCE", async () => {
    const { db, statements } = createFakeDb();
    await markPaymentStatus(db, "pr_1", "completed", "2026-01-01T00:00:00.000Z");

    expect(statements[0]?.sql).toContain("UPDATE credit_payments");
    expect(statements[0]?.sql).toContain("COALESCE(?, credited_at)");
    expect(statements[0]?.args).toEqual([
      "completed",
      "2026-01-01T00:00:00.000Z",
      expect.any(String),
      "pr_1",
    ]);
  });
});
