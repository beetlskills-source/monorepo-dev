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
import {
  CREDIT_ACTION_BOOK_SUMMARY,
  rateForAction,
  recordUsage,
  resolveCreditRates,
} from "../../lib/credits";
import { createFeatherlessClient } from "../../lib/featherless";
import { readShelfEntitlement } from "../../lib/llm-entitlement";

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
  /**
   * Whether the caller's saved "Enrich book info with LLM" preference allows
   * enrichment. Defaults to `false` (off), matching the unset/default-`No`
   * product default, so a lookup never waits on the LLM unless the user opted
   * in. When `false`, only the fast catalog lookup runs.
   */
  enrich?: boolean;
  /** Injectable fetch implementation; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  temperature?: number;
  /**
   * Meter a successful summary against the user's credit balance. Invoked
   * best-effort after enrichment produces a non-empty summary; a metering
   * failure never fails the lookup.
   */
  chargeUsage?: (units: number) => Promise<unknown>;
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
 * Run the metering callback without letting a metering failure break the
 * lookup: the LLM work is already done, so the catalog result still returns.
 */
async function meterUsage(
  charge: ((units: number) => Promise<unknown>) | undefined,
  units = 1,
): Promise<void> {
  if (!charge) return;
  try {
    await charge(units);
  } catch (error) {
    console.warn(
      "[credits] usage metering failed:",
      error instanceof Error ? error.message : error,
    );
  }
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

  // Enrichment is best-effort and opt-in: it runs only when the deployment has
  // a key *and* the caller's saved "Enrich book info with LLM" preference is
  // on. Without either, the fast catalog result is returned immediately, and any
  // failure still degrades gracefully (`enriched: false`) without overriding
  // the verified catalog identity.
  let summary: string | null = null;
  if (dependencies.apiKey && (dependencies.enrich ?? false)) {
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
      // Meter only when a summary was actually produced (best-effort).
      if (summary !== null) await meterUsage(dependencies.chargeUsage, 1);
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
export const POST: APIRoute = async (context) => {
  // Enrichment is a Paid-Registered-only AI feature. It runs only when the
  // caller is signed in, holds the one-time $0.99 LLM unlock, *and* has the
  // "Enrich book info with LLM" preference on. Anonymous visitors and every
  // free tier fall through to the fast catalog-only lookup, so a free user can
  // never reach Featherless.
  let enrich = false;
  const user = context.locals.user;
  if (user) {
    // Single-source entitlement read; fails closed to no enrichment so a free
    // tier (or a D1 error) can never reach Featherless by accident.
    const entitlement = await readShelfEntitlement(env.DB, user.id);
    enrich = entitlement.enrichWithLlm && entitlement.hasLlmUnlock;
  }

  const rate = rateForAction(resolveCreditRates(env), CREDIT_ACTION_BOOK_SUMMARY);

  return handleIsbnLookup(context, {
    apiKey: env.FEATHERLESS_API_KEY,
    model: env.FEATHERLESS_MODEL,
    googleBooksApiKey: env.GOOGLE_BOOKS_API_KEY,
    enrich,
    chargeUsage: user
      ? (units) =>
          recordUsage(env.DB, user.id, {
            action: CREDIT_ACTION_BOOK_SUMMARY,
            amount: rate * units,
          })
      : undefined,
  });
};
