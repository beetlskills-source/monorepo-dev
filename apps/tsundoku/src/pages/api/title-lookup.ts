import type { APIContext, APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  TitleLookupRequestSchema,
  TitleLookupResponseSchema,
} from "@repo/book-schemas";
import { createCatalogClient } from "../../lib/catalog";
import { errorResponse, jsonResponse } from "../../lib/http";

export const prerender = false;

/**
 * Overridable server-side configuration for the title lookup. The key and
 * `fetchImpl` are injectable so tests never touch the live network or secrets.
 */
export interface TitleLookupDependencies {
  /** Optional Google Books API key for the catalog fallback. */
  googleBooksApiKey?: string;
  /** Injectable fetch implementation; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Testable `POST /api/title-lookup` handler for the "Read Book Title"
 * fallback: resolve candidate editions by title (and optional author) via Open
 * Library's search API, falling back to Google Books. Returns `[]` (200) when
 * no edition matches so the caller can still offer a manual, no-ISBN save.
 */
export async function handleTitleLookup(
  context: Pick<APIContext, "request">,
  dependencies: TitleLookupDependencies = {},
): Promise<Response> {
  let payload: unknown;
  try {
    payload = await context.request.json();
  } catch {
    return errorResponse(400, "INVALID_REQUEST", "Request body must be valid JSON.");
  }

  const parsed = TitleLookupRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      "Request must include a non-empty string 'title' field.",
    );
  }

  const catalog = createCatalogClient({
    fetchImpl: dependencies.fetchImpl,
    googleBooksApiKey: dependencies.googleBooksApiKey,
    timeoutMs: dependencies.timeoutMs,
  });

  try {
    const editions = await catalog.searchEditions({
      title: parsed.data.title,
      author: parsed.data.author,
    });
    return jsonResponse(TitleLookupResponseSchema.parse({ editions }), 200);
  } catch {
    return errorResponse(
      502,
      "UPSTREAM_ERROR",
      "The catalog providers could not be reached.",
    );
  }
}

/** Production route: wires the real Cloudflare `env` into the handler. */
export const POST: APIRoute = async (context) => {
  return handleTitleLookup(context, {
    googleBooksApiKey: env.GOOGLE_BOOKS_API_KEY,
  });
};
