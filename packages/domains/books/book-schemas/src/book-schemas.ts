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
