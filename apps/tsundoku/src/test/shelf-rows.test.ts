import { describe, expect, it } from "vitest";
import {
  applyRowEdits,
  filterSharedRows,
  hasBlankSummary,
  isHeaderRow,
  isEmptyRow,
  isSharedRow,
  mapSheetValues,
  normalizeVisibility,
  SHEET_HEADER_ROW_INDEX,
  SHELF_COLUMN_COUNT,
  ShelfRowDeleteSchema,
  ShelfRowEditSchema,
  shelfRowFromCanonical,
  shelfColumnRange,
  shelfRowRange,
  shelfRowToValues,
  shelfSummaryRange,
  type ShelfRow,
} from "../lib/shelf-rows";
import { SHEET_HEADER_ROW } from "../lib/sheet-flow";

const header = [...SHEET_HEADER_ROW];
const dataRow = [
  "9780306406157",
  "Example Title",
  "Ada Lovelace; Alan Turing",
  "Acme",
  "1843",
  "A summary",
  "openlibrary",
  "true",
  "false",
  "high",
  "shared",
  "reader@example.com",
  "2026-01-01T00:00:00.000Z",
  "friend@example.com",
  "group-1,group-2",
];

describe("canonical constants", () => {
  it("matches the canonical column count and header row index", () => {
    expect(SHELF_COLUMN_COUNT).toBe(15);
    expect(SHEET_HEADER_ROW_INDEX).toBe(1);
  });
});

describe("isHeaderRow", () => {
  it("detects the canonical header regardless of case/whitespace", () => {
    expect(isHeaderRow(header)).toBe(true);
    expect(isHeaderRow([" ISBN13 ", "title"])).toBe(true);
    expect(isHeaderRow(["9780306406157", "Title"])).toBe(false);
    expect(isHeaderRow([])).toBe(false);
  });
});

describe("shelfRowFromCanonical / shelfRowToValues", () => {
  it("maps A..O into typed fields and round-trips", () => {
    const row = shelfRowFromCanonical(2, dataRow);
    expect(row.rowIndex).toBe(2);
    expect(row.title).toBe("Example Title");
    expect(row.visibility).toBe("shared");
    expect(row.transferredFrom).toBe("friend@example.com");
    expect(row.groups).toBe("group-1,group-2");
    expect(shelfRowToValues(row)).toEqual(dataRow);
  });

  it("fills missing cells with empty strings", () => {
    const row = shelfRowFromCanonical(5, ["9780306406157"]);
    expect(row.title).toBe("");
    expect(row.transferredFrom).toBe("");
    expect(shelfRowToValues(row)).toHaveLength(SHELF_COLUMN_COUNT);
  });
});

describe("isEmptyRow", () => {
  it("treats all-blank rows as empty", () => {
    expect(isEmptyRow(shelfRowFromCanonical(2, []))).toBe(true);
    expect(isEmptyRow(shelfRowFromCanonical(2, ["  ", ""]))).toBe(true);
    expect(isEmptyRow(shelfRowFromCanonical(2, dataRow))).toBe(false);
  });
});

describe("mapSheetValues", () => {
  it("skips the header, drops blanks, and keeps true row indices", () => {
    const rows = mapSheetValues([
      header,
      dataRow,
      [], // blank spacer row 3
      [
        "9781861972712",
        "Another",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "private",
        "",
        "",
        "",
        "",
      ],
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.rowIndex).toBe(2);
    expect(rows[1]?.rowIndex).toBe(4);
    expect(rows[1]?.isbn13).toBe("9781861972712");
  });

  it("handles a matrix with no header row", () => {
    const rows = mapSheetValues([dataRow]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rowIndex).toBe(1);
  });

  it("returns an empty list for an empty matrix", () => {
    expect(mapSheetValues([])).toEqual([]);
  });
});

describe("visibility helpers", () => {
  it("coerces unknown values to private", () => {
    expect(normalizeVisibility("shared")).toBe("shared");
    expect(normalizeVisibility(" SHARED ")).toBe("shared");
    expect(normalizeVisibility("private")).toBe("private");
    expect(normalizeVisibility("weird")).toBe("private");
    expect(normalizeVisibility("")).toBe("private");
  });

  it("filters a mixed shelf down to shared rows", () => {
    const shared = shelfRowFromCanonical(2, dataRow);
    const priv = shelfRowFromCanonical(3, [
      ...dataRow.slice(0, 10),
      "private",
      "",
      "",
      "",
      "",
    ] as string[]);
    expect(isSharedRow(shared)).toBe(true);
    expect(isSharedRow(priv)).toBe(false);
    expect(filterSharedRows([shared, priv])).toEqual([shared]);
  });
});

describe("range helpers", () => {
  it("covers every canonical column", () => {
    expect(shelfColumnRange("Books")).toBe("'Books'!A1:O");
    expect(shelfRowRange("Books", 2)).toBe("'Books'!A2:O2");
    expect(shelfRowRange("O'Brien", 10)).toBe("'O''Brien'!A10:O10");
  });

  it("targets just the summary cell (column F) for a batch backfill", () => {
    expect(shelfSummaryRange("Books", 2)).toBe("'Books'!F2");
    expect(shelfSummaryRange("Books", 42)).toBe("'Books'!F42");
    expect(shelfSummaryRange("O'Brien", 3)).toBe("'O''Brien'!F3");
  });
});

describe("hasBlankSummary", () => {
  it("flags blank and whitespace-only summaries", () => {
    expect(hasBlankSummary(shelfRowFromCanonical(2, dataRow))).toBe(false);
    const blank = shelfRowFromCanonical(2, [
      "9780306406157",
      "Title",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ]);
    expect(hasBlankSummary(blank)).toBe(true);
    expect(hasBlankSummary({ ...blank, summary: "   " })).toBe(true);
    expect(hasBlankSummary({ ...blank, summary: "Kept." })).toBe(false);
  });
});

describe("applyRowEdits", () => {
  const row: ShelfRow = shelfRowFromCanonical(2, dataRow);

  it("overlays editable fields while preserving provenance", () => {
    const updated = applyRowEdits(row, {
      title: "New Title",
      visibility: "private",
    });
    expect(updated.title).toBe("New Title");
    expect(updated.visibility).toBe("private");
    // Provenance columns stay untouched.
    expect(updated.isbn13).toBe(row.isbn13);
    expect(updated.source).toBe(row.source);
    expect(updated.ownerEmail).toBe(row.ownerEmail);
    expect(updated.addedAt).toBe(row.addedAt);
    expect(updated.transferredFrom).toBe(row.transferredFrom);
  });

  it("leaves fields absent from the patch unchanged", () => {
    const updated = applyRowEdits(row, { authors: "Someone Else" });
    expect(updated.authors).toBe("Someone Else");
    expect(updated.title).toBe(row.title);
    expect(updated.publisher).toBe(row.publisher);
  });
});

describe("edit/delete schemas", () => {
  it("accepts a row edit and rejects reserved rows", () => {
    expect(
      ShelfRowEditSchema.safeParse({ rowIndex: 2, fields: { title: "T" } }).success,
    ).toBe(true);
    expect(ShelfRowEditSchema.safeParse({ rowIndex: 1, fields: {} }).success).toBe(false);
    expect(ShelfRowEditSchema.safeParse({ rowIndex: 2.5, fields: {} }).success).toBe(false);
    expect(ShelfRowEditSchema.safeParse({ rowIndex: 2 }).success).toBe(false);
  });

  it("rejects an out-of-range visibility value", () => {
    expect(
      ShelfRowEditSchema.safeParse({ rowIndex: 2, fields: { visibility: "public" } }).success,
    ).toBe(false);
  });

  it("accepts a delete body and rejects the header row", () => {
    expect(ShelfRowDeleteSchema.safeParse({ rowIndex: 3 }).success).toBe(true);
    expect(ShelfRowDeleteSchema.safeParse({ rowIndex: 1 }).success).toBe(false);
    expect(ShelfRowDeleteSchema.safeParse({}).success).toBe(false);
  });
});
