import { describe, expect, it } from "vitest";
import {
  ApiErrorResponseSchema,
  BookEnrichmentSchema,
  BookLookupResultSchema,
  CatalogBookSchema,
  CatalogEditionSchema,
  CoverExtractRequestSchema,
  CoverExtractionSchema,
  CoverLookupResponseSchema,
  IsbnLookupRequestSchema,
  SaveableBookSchema,
  TitleLookupRequestSchema,
  TitleLookupResponseSchema,
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

describe("TitleLookupRequestSchema", () => {
  it("requires a non-empty title and trims whitespace", () => {
    const parsed = TitleLookupRequestSchema.safeParse({ title: "  Dune  " });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.title).toBe("Dune");
  });

  it("accepts an optional author refinement", () => {
    expect(
      TitleLookupRequestSchema.safeParse({ title: "Dune", author: "Herbert" })
        .success,
    ).toBe(true);
    expect(
      TitleLookupRequestSchema.safeParse({ title: "Dune", author: "   " }).success,
    ).toBe(false);
  });

  it("rejects a missing or blank title", () => {
    expect(TitleLookupRequestSchema.safeParse({}).success).toBe(false);
    expect(TitleLookupRequestSchema.safeParse({ title: "   " }).success).toBe(false);
  });
});

describe("CatalogEditionSchema", () => {
  const edition = {
    title: "Dune",
    authors: ["Frank Herbert"],
    publisher: "Chilton",
    publishedYear: 1965,
    isbn13: "9780441172719",
    isbn10: "0441172717",
    source: "openlibrary",
  } as const;

  it("accepts an edition with both ISBN forms", () => {
    expect(CatalogEditionSchema.safeParse(edition).success).toBe(true);
  });

  it("accepts an edition that carries no ISBN", () => {
    expect(
      CatalogEditionSchema.safeParse({ ...edition, isbn13: null, isbn10: null })
        .success,
    ).toBe(true);
  });

  it("rejects an unknown source", () => {
    expect(
      CatalogEditionSchema.safeParse({ ...edition, source: "amazon" }).success,
    ).toBe(false);
  });
});

describe("TitleLookupResponseSchema", () => {
  it("accepts an empty editions array (no catalog match)", () => {
    expect(TitleLookupResponseSchema.safeParse({ editions: [] }).success).toBe(true);
  });

  it("rejects a missing editions field", () => {
    expect(TitleLookupResponseSchema.safeParse({}).success).toBe(false);
  });
});

describe("CoverExtractRequestSchema", () => {
  it("accepts a non-empty base64 image data URL", () => {
    expect(
      CoverExtractRequestSchema.safeParse({
        image: "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
      }).success,
    ).toBe(true);
  });

  it("rejects a missing or empty image field", () => {
    expect(CoverExtractRequestSchema.safeParse({}).success).toBe(false);
    expect(CoverExtractRequestSchema.safeParse({ image: "" }).success).toBe(false);
  });
});

describe("CoverExtractionSchema", () => {
  const extraction = {
    title: "The $100 Startup",
    subtitle: null,
    authors: ["Chris Guillebeau"],
    publisher: "Crown Business",
    isbn: "9780307951526",
  } as const;

  it("accepts a fully populated extraction", () => {
    expect(CoverExtractionSchema.safeParse(extraction).success).toBe(true);
  });

  it("accepts null subtitle/publisher/isbn and an empty authors list", () => {
    expect(
      CoverExtractionSchema.safeParse({
        ...extraction,
        subtitle: null,
        publisher: null,
        authors: [],
        isbn: null,
      }).success,
    ).toBe(true);
  });

  it("rejects an empty or missing title", () => {
    expect(
      CoverExtractionSchema.safeParse({ ...extraction, title: "" }).success,
    ).toBe(false);
    const { title: _title, ...withoutTitle } = extraction;
    expect(CoverExtractionSchema.safeParse(withoutTitle).success).toBe(false);
  });

  it("requires the isbn hint field to be present (null when unseen)", () => {
    const { isbn: _isbn, ...withoutIsbn } = extraction;
    expect(CoverExtractionSchema.safeParse(withoutIsbn).success).toBe(false);
  });
});

describe("CoverLookupResponseSchema", () => {
  const response = {
    title: "The $100 Startup",
    subtitle: null,
    authors: ["Chris Guillebeau"],
    publisher: "Crown Business",
    publishedYear: 2012,
    isbn: "9780307951526",
    summary: "A short summary.",
    enriched: true,
    source: "catalog_lookup",
    provider: "openlibrary",
    confidence: "high",
    candidates: [],
  } as const;

  it("accepts a catalog_lookup response", () => {
    expect(CoverLookupResponseSchema.safeParse(response).success).toBe(true);
  });

  it("accepts a populated candidates list", () => {
    expect(
      CoverLookupResponseSchema.safeParse({
        ...response,
        candidates: [
          {
            title: "The $100 Startup",
            authors: ["Chris Guillebeau"],
            publisher: "Crown Business",
            publishedYear: 2012,
            isbn13: "9780307951526",
            isbn10: null,
            source: "openlibrary",
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("requires the candidates list", () => {
    const { candidates: _candidates, ...withoutCandidates } = response;
    expect(
      CoverLookupResponseSchema.safeParse(withoutCandidates).success,
    ).toBe(false);
  });

  it("accepts a vision_only response with null isbn and no provider", () => {
    expect(
      CoverLookupResponseSchema.safeParse({
        ...response,
        publishedYear: null,
        isbn: null,
        authors: [],
        summary: null,
        enriched: false,
        source: "vision_only",
        provider: null,
        confidence: "low",
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown source", () => {
    expect(
      CoverLookupResponseSchema.safeParse({ ...response, source: "guess" }).success,
    ).toBe(false);
  });

  it("rejects an unknown provider", () => {
    expect(
      CoverLookupResponseSchema.safeParse({ ...response, provider: "amazon" })
        .success,
    ).toBe(false);
  });

  it("rejects an unknown confidence", () => {
    expect(
      CoverLookupResponseSchema.safeParse({ ...response, confidence: "certain" })
        .success,
    ).toBe(false);
  });

  it("requires the enriched flag", () => {
    const { enriched: _enriched, ...withoutEnriched } = response;
    expect(CoverLookupResponseSchema.safeParse(withoutEnriched).success).toBe(
      false,
    );
  });
});

describe("SaveableBookSchema", () => {
  it("accepts a catalog-shaped book (assignable from a lookup result)", () => {
    expect(SaveableBookSchema.safeParse(VALID_RESULT).success).toBe(true);
  });

  it("accepts an uncataloged manual book with a blank isbn13", () => {
    expect(
      SaveableBookSchema.safeParse({
        isbn13: "",
        title: "Uncataloged Journal",
        authors: ["Unknown"],
        publisher: null,
        publishedYear: null,
        summary: null,
        source: "manual",
        verified: false,
        enriched: false,
        confidence: "low",
      }).success,
    ).toBe(true);
  });

  it("rejects an empty title and an unknown source", () => {
    expect(
      SaveableBookSchema.safeParse({ ...VALID_RESULT, title: "" }).success,
    ).toBe(false);
    expect(
      SaveableBookSchema.safeParse({ ...VALID_RESULT, source: "amazon" }).success,
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
