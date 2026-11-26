import type { APIContext, APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  ApiErrorResponseSchema,
  BookLookupResultSchema,
  IsbnLookupRequestSchema,
  type ApiErrorCode,
} from "@repo/book-schemas";
import { toIsbn13 } from "@repo/isbn";
import { createCatalogClient } from "../../lib/catalog";
import { createFeatherlessClient } from "../../lib/featherless";

export const prerender = false;

/**
 * Overridable server-side configuration for the lookup handler. Keys and
 * `fetchImpl` are injectable so tests never touch the live network or secrets.
 */
export interface IsbnLookupDependencies {
  /** Optional Featherless API key. When absent, enrichment is skipped. */
  apiKey?: string;
  /** Optional model override; defaults inside the Featherless client. */
  model?: string;
  /** Optional Google Books API key for the catalog fallback. */
  googleBooksApiKey?: string;
  /** Injectable fetch implementation; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  temperature?: number;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(
  status: number,
  error: ApiErrorCode,
  message: string,
): Response {
  return jsonResponse(ApiErrorResponseSchema.parse({ error, message }), status);
}

/**
 * Testable `POST /api/isbn-lookup` handler implementing the catalog-first
 * pipeline: validate the ISBN, resolve authoritative identity from the catalog
 * (Open Library, then Google Books), then optionally enrich it with Featherless
 * AI without overriding verified `title` / `authors`.
 */
export async function handleIsbnLookup(
  context: Pick<APIContext, "request">,
  dependencies: IsbnLookupDependencies = {},
): Promise<Response> {
  let payload: unknown;
  try {
    payload = await context.request.json();
  } catch {
    return errorResponse(400, "INVALID_ISBN", "Request body must be valid JSON.");
  }

  const parsed = IsbnLookupRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return errorResponse(
      400,
      "INVALID_ISBN",
      "Request must include a non-empty string 'isbn' field.",
    );
  }

  const isbn13 = toIsbn13(parsed.data.isbn);
  if (isbn13 === null) {
    return errorResponse(
      400,
      "INVALID_ISBN",
      "The provided value is not a valid ISBN-10 or ISBN-13.",
    );
  }

  const catalog = createCatalogClient({
    fetchImpl: dependencies.fetchImpl,
    googleBooksApiKey: dependencies.googleBooksApiKey,
    timeoutMs: dependencies.timeoutMs,
  });

  let book;
  try {
    book = await catalog.lookupByIsbn(isbn13);
  } catch {
    return errorResponse(
      502,
      "UPSTREAM_ERROR",
      "The catalog providers could not resolve this ISBN.",
    );
  }

  if (book === null) {
    return errorResponse(
      422,
      "BOOK_NOT_FOUND",
      "No catalog record matched this ISBN.",
    );
  }

  // Enrichment is best-effort and optional: without a key we skip the LLM
  // entirely, and any failure degrades gracefully (`enriched: false`) without
  // overriding the verified catalog identity.
  let summary: string | null = null;
  if (dependencies.apiKey) {
    try {
      const enrichment = createFeatherlessClient({
        apiKey: dependencies.apiKey,
        model: dependencies.model,
        fetchImpl: dependencies.fetchImpl,
        timeoutMs: dependencies.timeoutMs,
        temperature: dependencies.temperature,
      });
      const result = await enrichment.enrichBook(book);
      summary =
        result.summary !== null && result.summary.trim() !== ""
          ? result.summary
          : null;
    } catch (error) {
      // Best-effort enrichment: keep the catalog result alive, but record the
      // reason server-side. Without this, a timed-out or failed enrichment is
      // indistinguishable from "no key configured" and silently yields
      // `enriched: false` on every request.
      console.warn(
        "[isbn-lookup] enrichment skipped:",
        error instanceof Error ? error.message : error,
      );
      summary = null;
    }
  }

  const response = BookLookupResultSchema.parse({
    isbn13: book.isbn13,
    title: book.title,
    authors: book.authors,
    publisher: book.publisher,
    publishedYear: book.publishedYear,
    summary,
    source: book.source,
    verified: book.verified,
    enriched: summary !== null,
    confidence: book.verified ? "high" : "low",
  });

  return jsonResponse(response, 200);
}

/** Production route: wires the real Cloudflare `env` into the handler. */
export const POST: APIRoute = (context) =>
  handleIsbnLookup(context, {
    apiKey: env.FEATHERLESS_API_KEY,
    model: env.FEATHERLESS_MODEL,
    googleBooksApiKey: env.GOOGLE_BOOKS_API_KEY,
  });
