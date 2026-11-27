import { describe, expect, it } from "vitest";
import type { BookLookupResult } from "@repo/book-schemas";
import {
  buildSheetRow,
  columnLetter,
  createPkcePair,
  decodeOAuthStateCookie,
  encodeOAuthStateCookie,
  EnrichSettingRequestSchema,
  sheetHeaderRange,
  sheetRange,
  SHEET_HEADER_ROW,
  ShelfSetupRequestSchema,
} from "../lib/sheet-flow";

const book: BookLookupResult = {
  isbn13: "9780306406157",
  title: "Example Title",
  authors: ["Ada Lovelace", "Alan Turing"],
  publisher: null,
  publishedYear: null,
  summary: null,
  source: "openlibrary",
  verified: true,
  enriched: false,
  confidence: "high",
};

describe("createPkcePair", () => {
  it("produces a verifier and a distinct base64url challenge", async () => {
    const { verifier, challenge } = await createPkcePair();
    expect(verifier.length).toBeGreaterThan(20);
    expect(challenge).not.toBe(verifier);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("OAuth state cookie", () => {
  it("round-trips the state and verifier", () => {
    const encoded = encodeOAuthStateCookie("state-1", "verifier-1");
    expect(decodeOAuthStateCookie(encoded)).toEqual({
      state: "state-1",
      verifier: "verifier-1",
    });
  });

  it("returns null for malformed or non-JSON payloads", () => {
    expect(decodeOAuthStateCookie("!!!not-base64url!!!")).toBeNull();
    expect(decodeOAuthStateCookie("")).toBeNull();
  });
});

describe("range helpers", () => {
  it("quotes the tab name and escapes embedded apostrophes", () => {
    expect(sheetRange("Books", "A1")).toBe("'Books'!A1");
    expect(sheetRange("O'Brien", "A1")).toBe("'O''Brien'!A1");
  });

  it("falls back to the default tab for blank names", () => {
    expect(sheetRange("   ", "A1")).toBe("'Books'!A1");
  });

  it("converts column counts to spreadsheet letters", () => {
    expect(columnLetter(1)).toBe("A");
    expect(columnLetter(14)).toBe("N");
    expect(columnLetter(15)).toBe("O");
    expect(columnLetter(26)).toBe("Z");
    expect(columnLetter(27)).toBe("AA");
  });

  it("spans exactly the header columns", () => {
    expect(sheetHeaderRange("Books")).toBe("'Books'!A1:O1");
    expect(SHEET_HEADER_ROW).toHaveLength(15);
  });
});

describe("buildSheetRow", () => {
  it("flattens a book into a header-aligned row", () => {
    const row = buildSheetRow({
      book,
      visibility: "private",
      ownerEmail: "reader@example.com",
      addedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(row).toEqual([
      "9780306406157",
      "Example Title",
      "Ada Lovelace; Alan Turing",
      "",
      "",
      "",
      "openlibrary",
      "true",
      "false",
      "high",
      "private",
      "reader@example.com",
      "2026-01-01T00:00:00.000Z",
      "",
      "",
    ]);
    expect(row).toHaveLength(SHEET_HEADER_ROW.length);
  });

  it("renders nullable and transfer fields as empty strings", () => {
    const row = buildSheetRow({
      book: { ...book, publisher: "Acme", publishedYear: 1843, summary: "Hi" },
      visibility: "shared",
      ownerEmail: "reader@example.com",
      addedAt: "2026-01-01T00:00:00.000Z",
      transferredFrom: "friend@example.com",
    });
    expect(row[3]).toBe("Acme");
    expect(row[4]).toBe("1843");
    expect(row[5]).toBe("Hi");
    expect(row[13]).toBe("friend@example.com");
  });
});

describe("ShelfSetupRequestSchema", () => {
  it("accepts create, bind, and detach actions", () => {
    expect(ShelfSetupRequestSchema.safeParse({ action: "create" }).success).toBe(
      true,
    );
    expect(
      ShelfSetupRequestSchema.safeParse({ action: "bind", spreadsheetId: "abc" })
        .success,
    ).toBe(true);
    expect(ShelfSetupRequestSchema.safeParse({ action: "detach" }).success).toBe(
      true,
    );
  });

  it("accepts an optional tab name when binding", () => {
    const parsed = ShelfSetupRequestSchema.safeParse({
      action: "bind",
      spreadsheetId: "abc",
      sheetTabName: "Wishlist",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.sheetTabName).toBe("Wishlist");
  });

  it("rejects unknown actions", () => {
    expect(
      ShelfSetupRequestSchema.safeParse({ action: "delete-everything" }).success,
    ).toBe(false);
  });
});

describe("EnrichSettingRequestSchema", () => {
  it("accepts a boolean preference and rejects anything else", () => {
    expect(
      EnrichSettingRequestSchema.safeParse({ enrichWithLlm: true }).success,
    ).toBe(true);
    expect(
      EnrichSettingRequestSchema.safeParse({ enrichWithLlm: false }).success,
    ).toBe(true);
    // A string ("yes"/"no") or a missing field must be rejected so the route's
    // stored integer can never drift from a real boolean.
    expect(
      EnrichSettingRequestSchema.safeParse({ enrichWithLlm: "yes" }).success,
    ).toBe(false);
    expect(EnrichSettingRequestSchema.safeParse({}).success).toBe(false);
  });
});
