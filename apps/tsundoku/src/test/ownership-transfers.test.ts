import { describe, expect, it } from "vitest";
import {
  createTransferId,
  recordOwnershipTransfer,
  type OwnershipTransferRecord,
} from "../lib/ownership-transfers";

interface RecordedStatement {
  sql: string;
  args: unknown[];
}

/** D1 double that records the executed statement and its bound args. */
function createRecordingDb() {
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
          return { success: true };
        },
      };
      return statement;
    },
  };
  return { db: db as unknown as D1Database, statements };
}

const record: OwnershipTransferRecord = {
  id: "t-1",
  fromUserId: "from-1",
  fromEmail: "from@example.com",
  toUserId: "to-1",
  toEmail: "to@example.com",
  fromSpreadsheetId: "src-sheet",
  fromSheetTabName: "Books",
  toSpreadsheetId: "dst-sheet",
  toSheetTabName: "Books",
  isbn13: "9780306406157",
  title: "Some Book",
  status: "completed",
  errorMessage: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:00.000Z",
};

describe("recordOwnershipTransfer", () => {
  it("inserts one audit row binding every column in order", async () => {
    const { db, statements } = createRecordingDb();
    await recordOwnershipTransfer(db, record);

    expect(statements[0]?.sql).toContain("INSERT INTO ownership_transfers");
    expect(statements[0]?.args).toEqual([
      "t-1",
      "from-1",
      "from@example.com",
      "to-1",
      "to@example.com",
      "src-sheet",
      "Books",
      "dst-sheet",
      "Books",
      "9780306406157",
      "Some Book",
      "completed",
      null,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ]);
  });

  it("records a failed attempt with its reason and no completion time", async () => {
    const { db, statements } = createRecordingDb();
    await recordOwnershipTransfer(db, {
      ...record,
      status: "failed",
      errorMessage: "Google denied the append.",
      completedAt: null,
    });

    const args = statements[0]?.args ?? [];
    expect(args).toContain("failed");
    expect(args).toContain("Google denied the append.");
    expect(args.at(-1)).toBeNull();
  });
});

describe("createTransferId", () => {
  it("returns a non-empty, unique id", () => {
    const first = createTransferId();
    const second = createTransferId();
    expect(first).not.toBe("");
    expect(first).not.toBe(second);
  });
});
