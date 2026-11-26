import { describe, expect, it } from "vitest";
import {
  ApiErrorResponseSchema,
  BookEnrichmentSchema,
  BookLookupResultSchema,
  CatalogBookSchema,
  IsbnLookupRequestSchema,
} from "./index";

const VALID_CATALOG_BOOK = {
  isbn13: "9780306406157",
  title: "The C Programming Language",
  authors: ["Brian W. Kernighan", "Dennis M. Ritchie"],
  publisher: "Prentice Hall",
  publishedYear: 1978,
  source: "openlibrary",
  verified: true,
} as const;

const VALID_RESULT = {
  ...VALID_CATALOG_BOOK,
  summary: "A concise summary.",
  enriched: true,
  confidence: "high",
} as const;

describe("IsbnLookupRequestSchema", () => {
  it("accepts a non-empty isbn string", () => {
    expect(
      IsbnLookupRequestSchema.safeParse({ isbn: "9780306406157" }).success,
    ).toBe(true);
  });

  it("rejects a missing or empty isbn field", () => {
    expect(IsbnLookupRequestSchema.safeParse({}).success).toBe(false);
    expect(IsbnLookupRequestSchema.safeParse({ isbn: "" }).success).toBe(false);
  });

  it("rejects a non-string isbn field", () => {
    expect(IsbnLookupRequestSchema.safeParse({ isbn: 9780306406157 }).success).toBe(
      false,
    );
  });
});

describe("CatalogBookSchema", () => {
  it("accepts an authoritative catalog record", () => {
    expect(CatalogBookSchema.safeParse(VALID_CATALOG_BOOK).success).toBe(true);
  });

  it("accepts null publisher and publishedYear", () => {
    expect(
      CatalogBookSchema.safeParse({
        ...VALID_CATALOG_BOOK,
        publisher: null,
        publishedYear: null,
      }).success,
    ).toBe(true);
  });

  it("rejects an unverified record", () => {
    expect(
      CatalogBookSchema.safeParse({ ...VALID_CATALOG_BOOK, verified: false }).success,
    ).toBe(false);
  });

  it("rejects an unknown catalog source", () => {
    expect(
      CatalogBookSchema.safeParse({ ...VALID_CATALOG_BOOK, source: "amazon" }).success,
    ).toBe(false);
  });

  it("rejects an isbn13 that is not 13 digits", () => {
    expect(
      CatalogBookSchema.safeParse({
        ...VALID_CATALOG_BOOK,
        isbn13: "978-0-306-40615-7",
      }).success,
    ).toBe(false);
  });
});

describe("BookEnrichmentSchema", () => {
  it("accepts a summary with optional topics", () => {
    expect(
      BookEnrichmentSchema.safeParse({ summary: "A summary.", topics: ["c"] }).success,
    ).toBe(true);
  });

  it("accepts a null summary", () => {
    expect(BookEnrichmentSchema.safeParse({ summary: null }).success).toBe(true);
  });

  it("rejects a missing summary", () => {
    expect(BookEnrichmentSchema.safeParse({ topics: ["c"] }).success).toBe(false);
  });
});

describe("BookLookupResultSchema", () => {
  it("accepts a fully populated result", () => {
    expect(BookLookupResultSchema.safeParse(VALID_RESULT).success).toBe(true);
  });

  it("accepts a null summary with enriched:false", () => {
    expect(
      BookLookupResultSchema.safeParse({
        ...VALID_RESULT,
        summary: null,
        enriched: false,
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown source value", () => {
    expect(
      BookLookupResultSchema.safeParse({ ...VALID_RESULT, source: "amazon" })
        .success,
    ).toBe(false);
  });

  it("rejects a missing enriched flag", () => {
    const { enriched: _enriched, ...withoutEnriched } = VALID_RESULT;
    expect(BookLookupResultSchema.safeParse(withoutEnriched).success).toBe(false);
  });

  it("rejects an unknown confidence value", () => {
    expect(
      BookLookupResultSchema.safeParse({ ...VALID_RESULT, confidence: "certain" })
        .success,
    ).toBe(false);
  });

  it("rejects a non-integer publishedYear", () => {
    expect(
      BookLookupResultSchema.safeParse({ ...VALID_RESULT, publishedYear: 1978.5 })
        .success,
    ).toBe(false);
  });
});

describe("ApiErrorResponseSchema", () => {
  it("accepts each documented error code", () => {
    for (const error of [
      "INVALID_ISBN",
      "BOOK_NOT_FOUND",
      "UPSTREAM_ERROR",
      "CONFIG_ERROR",
    ]) {
      expect(ApiErrorResponseSchema.safeParse({ error, message: "boom" }).success).toBe(
        true,
      );
    }
  });

  it("rejects an unknown error code or a missing message", () => {
    expect(
      ApiErrorResponseSchema.safeParse({ error: "TEAPOT", message: "x" }).success,
    ).toBe(false);
    expect(ApiErrorResponseSchema.safeParse({ error: "INVALID_ISBN" }).success).toBe(
      false,
    );
  });
});
