import { z } from "zod";
import { Isbn13Schema } from "@repo/isbn";

/**
 * Request body for `POST /api/isbn-lookup`.
 * `isbn` accepts a raw or formatted ISBN-10 / ISBN-13 string.
 */
export const IsbnLookupRequestSchema = z.object({
  isbn: z.string().min(1, "isbn is required"),
});

export type IsbnLookupRequest = z.infer<typeof IsbnLookupRequestSchema>;

/** Catalog providers that own authoritative `title` / `authors`. */
export const CatalogSourceSchema = z.enum(["openlibrary", "google-books"]);

export type CatalogSource = z.infer<typeof CatalogSourceSchema>;

/**
 * Authoritative catalog record. `title` and `authors` are treated as verified
 * as-is; LLM enrichment must never overwrite them.
 */
export const CatalogBookSchema = z.object({
  isbn13: Isbn13Schema,
  title: z.string(),
  authors: z.array(z.string()),
  publisher: z.string().nullable(),
  publishedYear: z.number().int().nullable(),
  source: CatalogSourceSchema,
  verified: z.literal(true),
});

export type CatalogBook = z.infer<typeof CatalogBookSchema>;

/**
 * Request body for `POST /api/title-lookup` (AI / "Read Book Title" fallback).
 * `title` is required; `author` is an optional refinement used to disambiguate
 * common titles.
 */
export const TitleLookupRequestSchema = z.object({
  title: z.string().trim().min(1, "title is required"),
  author: z.string().trim().min(1).optional(),
});

export type TitleLookupRequest = z.infer<typeof TitleLookupRequestSchema>;

/**
 * A candidate edition surfaced by a title/author search. Unlike
 * {@link CatalogBookSchema} the identifiers may be `null` (not every provider
 * record carries an ISBN) and several editions may be returned, so the user
 * disambiguates instead of the app silently picking one.
 */
export const CatalogEditionSchema = z.object({
  title: z.string(),
  authors: z.array(z.string()),
  publisher: z.string().nullable(),
  publishedYear: z.number().int().nullable(),
  isbn13: z.string().nullable(),
  isbn10: z.string().nullable(),
  source: CatalogSourceSchema,
});

export type CatalogEdition = z.infer<typeof CatalogEditionSchema>;

/** `200 OK` body for `POST /api/title-lookup`. */
export const TitleLookupResponseSchema = z.object({
  editions: z.array(CatalogEditionSchema),
});

export type TitleLookupResponse = z.infer<typeof TitleLookupResponseSchema>;

/**
 * Request body for `POST /api/books/extract-cover` (Paid-Registered vision
 * "Read Book Title"). `image` is a base64 data URL of a compressed JPEG/WebP
 * cover photo, down-scaled on the client before upload.
 */
export const CoverExtractRequestSchema = z.object({
  image: z.string().min(1, "image is required"),
});

export type CoverExtractRequest = z.infer<typeof CoverExtractRequestSchema>;

/**
 * Raw vision-model hints read from a cover photo. These are **hints, not ground
 * truth**: `title` and `isbn` are only used to query a real catalog, and the
 * model is instructed to `null`/empty any field it cannot actually see. `title`
 * is the single coherent display title (multi-line titles are joined);
 * `subtitle` / `publisher` / `isbn` are `null` and `authors` is empty when the
 * field is not visible — the model must never guess a value it cannot see.
 */
export const CoverExtractionSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().nullable(),
  authors: z.array(z.string()),
  publisher: z.string().nullable(),
  /** Digits read off the cover (any format); a lookup hint, never authoritative. */
  isbn: z.string().nullable(),
});

export type CoverExtraction = z.infer<typeof CoverExtractionSchema>;

/**
 * Provenance of the resolved cover metadata returned by
 * `POST /api/books/extract-cover`:
 * - `"catalog_lookup"` — canonical details were resolved from an external
 *   catalog search (Open Library / Google Books).
 * - `"vision_only"` — no catalog match (or the catalog was unavailable), so the
 *   vision model's grounded hints are all we have.
 */
export const CoverMetadataSourceSchema = z.enum(["vision_only", "catalog_lookup"]);

export type CoverMetadataSource = z.infer<typeof CoverMetadataSourceSchema>;

/**
 * Strict `200 OK` body of `POST /api/books/extract-cover`: the resolved
 * `{ title, subtitle, authors, publisher, publishedYear, isbn }` plus a
 * `source` provenance flag and the (optional) LLM enrichment. The response is a
 * **complete single-pass result** — the catalog promotion and the best-effort
 * `summary` enrichment both run server-side, so the client can render the match
 * directly without a second lookup. `title`/`authors`/`publisher`/`isbn` prefer
 * verified catalog metadata over raw vision guesses whenever a match is found.
 */
export const CoverLookupResponseSchema = CoverExtractionSchema.extend({
  /** Catalog publication year; `null` for a vision-only read. */
  publishedYear: z.number().int().nullable(),
  /** Best-effort LLM summary, only when enrichment was enabled and succeeded. */
  summary: z.string().nullable(),
  /** Whether `summary` was produced by the LLM enrichment step. */
  enriched: z.boolean(),
  source: CoverMetadataSourceSchema,
  /**
   * Which catalog provider resolved the details (`openlibrary` | `google-books`),
   * or `null` for a `vision_only` read. Lets the caller persist the exact
   * provenance through the shared {@link SaveableBookSchema} save path.
   */
  provider: CatalogSourceSchema.nullable(),
  confidence: z.enum(["high", "medium", "low"]),
  /**
   * Catalog candidate editions surfaced for the cover's extracted title/ISBN
   * hint, offered to the caller as "Possible Book Titles" rows so the user can
   * disambiguate. Empty for a pure vision-only read with nothing to search on;
   * when a single hint resolved to a match this carries that edition.
   */
  candidates: z.array(CatalogEditionSchema),
});

export type CoverLookupResponse = z.infer<typeof CoverLookupResponseSchema>;

/**
 * Optional LLM enrichment for a catalog-verified book. Carries a concise
 * `summary` (possibly `null`) and optional topic tags only — never `title`
 * or `authors`.
 */
export const BookEnrichmentSchema = z.object({
  summary: z.string().nullable(),
  topics: z.array(z.string()).optional(),
});

export type BookEnrichment = z.infer<typeof BookEnrichmentSchema>;

/**
 * Final `200 OK` response: authoritative catalog identity combined with
 * optional LLM enrichment metadata.
 */
export const BookLookupResultSchema = z.object({
  isbn13: Isbn13Schema,
  title: z.string(),
  authors: z.array(z.string()),
  publisher: z.string().nullable(),
  publishedYear: z.number().int().nullable(),
  summary: z.string().nullable(),
  source: z.enum(["openlibrary", "google-books", "featherless-fallback"]),
  verified: z.boolean(),
  enriched: z.boolean(),
  confidence: z.enum(["high", "medium", "low"]),
});

export type BookLookupResult = z.infer<typeof BookLookupResultSchema>;

/** Source values a persisted shelf row may carry (adds the manual "Read Book Title" path). */
export const SaveableSourceSchema = z.enum([
  "openlibrary",
  "google-books",
  "featherless-fallback",
  "manual",
]);

export type SaveableSource = z.infer<typeof SaveableSourceSchema>;

/**
 * A shelf-writable book. Superset of {@link BookLookupResultSchema} that also
 * permits an uncataloged entry ("Read Book Title" with no catalog match):
 * `isbn13` may be a synthetic internal id or an empty string, and `source` may
 * be `"manual"`. Catalog results remain assignable to this shape.
 */
export const SaveableBookSchema = z.object({
  isbn13: z.string(),
  title: z.string().min(1),
  authors: z.array(z.string()),
  publisher: z.string().nullable(),
  publishedYear: z.number().int().nullable(),
  summary: z.string().nullable(),
  source: SaveableSourceSchema,
  verified: z.boolean(),
  enriched: z.boolean(),
  confidence: z.enum(["high", "medium", "low"]),
});

export type SaveableBook = z.infer<typeof SaveableBookSchema>;

/** Stable machine-readable error codes returned by the API. */
export const ApiErrorCodeSchema = z.enum([
  "INVALID_ISBN",
  "BOOK_NOT_FOUND",
  "UPSTREAM_ERROR",
  "CONFIG_ERROR",
]);

export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

/** Shape of every non-2xx JSON response body. */
export const ApiErrorResponseSchema = z.object({
  error: ApiErrorCodeSchema,
  message: z.string(),
});

export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
