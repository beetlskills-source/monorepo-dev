import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { toIsbn13 } from "@repo/isbn";
import {
  CREDIT_ACTION_BATCH_BOOK_SUMMARY,
  rateForAction,
  recordUsage,
  resolveCreditRates,
} from "../../../lib/credits";
import { enforceAiAccess } from "../../../lib/entitlements";
import { errorResponse, jsonResponse } from "../../../lib/http";
import { isLlmUnlocked } from "../../../lib/llm-entitlement";
import { resolveOwnContext } from "../../../lib/own-shelf";
import {
  hasBlankSummary,
  mapSheetValues,
  shelfColumnRange,
  shelfSummaryRange,
} from "../../../lib/shelf-rows";
import {
  createFeatherlessClient,
  type BatchEnrichmentInput,
} from "../../../lib/featherless";
import { googleSheetsErrorResponse } from "../../../lib/sheet-service";
import { invalidateSharedShelfCache } from "../../../lib/shelves";

export const prerender = false;

/**
 * Books per single LLM request. Large shelves are sent in a handful of bounded
 * chunks instead of one slow request per book, keeping the Worker well clear of
 * its timeout while still avoiding N sequential LLM calls.
 */
export const BATCH_CHUNK_SIZE = 25;

/** Parse the row's `publishedYear` cell into a number, or `null`. */
function parseYear(value: string): number | null {
  const year = Number.parseInt(value, 10);
  return Number.isFinite(year) ? year : null;
}

/** Split the flattened `authors` cell back into a list. */
function parseAuthors(value: string): string[] {
  return value
    .split(";")
    .map((author) => author.trim())
    .filter((author) => author !== "");
}

/**
 * Bulk-enrich every book on the signed-in user's shelf. Only rows with a valid
 * ISBN and a *blank* `summary` are considered, so existing or hand-edited
 * summaries are never overwritten. The unenriched books are sent to Featherless
 * in bounded chunks that return a JSON key → summary mapping; the summaries are
 * then written back into the `summary` column in a single `values:batchUpdate`.
 */
export const POST: APIRoute = async (context) => {
  const user = context.locals.user;
  if (!user) {
    return errorResponse(
      401,
      "UNAUTHENTICATED",
      "Sign in to enrich your shelf.",
    );
  }

  // Bulk enrichment is a Paid-Registered-only AI feature: gate on the one-time
  // $0.99 LLM unlock before any D1/Sheets work (single-source read, failing
  // closed so a free tier can never reach Featherless).
  const hasLlmUnlock = await isLlmUnlocked(env.DB, user.id);
  const denied = enforceAiAccess({ userId: user.id, hasLlmUnlock });
  if (denied) return denied;

  // OWNER prerequisites: a connected Google account plus a linked spreadsheet.
  const own = await resolveOwnContext(env, user.id);
  if (own instanceof Response) return own;

  const apiKey = env.FEATHERLESS_API_KEY;
  if (!apiKey) {
    return errorResponse(
      503,
      "CONFIG_ERROR",
      "LLM enrichment is not configured on this deployment.",
    );
  }

  let values: string[][];
  try {
    values = await own.client.getValues({
      accessToken: own.accessToken,
      spreadsheetId: own.spreadsheetId,
      range: shelfColumnRange(own.sheetTabName),
    });
  } catch (error) {
    return googleSheetsErrorResponse(error);
  }

  const rows = mapSheetValues(values);
  // Only valid-ISBN rows with an empty summary are candidates; rows without an
  // ISBN or that already carry a summary are skipped and left untouched.
  const candidates = rows.filter(
    (row) => hasBlankSummary(row) && toIsbn13(row.isbn13) !== null,
  );
  const skipped = rows.length - candidates.length;

  if (candidates.length === 0) {
    return jsonResponse({
      ok: true,
      total: rows.length,
      enriched: 0,
      skipped,
      updates: [],
      message:
        rows.length === 0
          ? "Your shelf is empty."
          : "Every book already has a summary.",
    });
  }

  const client = createFeatherlessClient({
    apiKey,
    model: env.FEATHERLESS_MODEL,
  });

  const updates: Array<{ rowIndex: number; summary: string }> = [];
  try {
    for (let i = 0; i < candidates.length; i += BATCH_CHUNK_SIZE) {
      const chunk = candidates.slice(i, i + BATCH_CHUNK_SIZE);
      const inputs: BatchEnrichmentInput[] = chunk.map((row) => ({
        // The row index is the correlation key echoed back by the model.
        key: String(row.rowIndex),
        isbn13: row.isbn13,
        title: row.title,
        authors: parseAuthors(row.authors),
        publisher: row.publisher || null,
        publishedYear: parseYear(row.publishedYear),
      }));

      const summaries = await client.enrichBooks(inputs);
      for (const row of chunk) {
        const summary = summaries.get(String(row.rowIndex));
        if (summary) updates.push({ rowIndex: row.rowIndex, summary });
      }
    }
  } catch (error) {
    // Nothing has been written yet, so a failed chunk is fully recoverable.
    return errorResponse(
      502,
      "UPSTREAM_ERROR",
      error instanceof Error
        ? error.message
        : "The LLM enrichment request failed.",
    );
  }

  if (updates.length === 0) {
    return jsonResponse({
      ok: true,
      total: rows.length,
      enriched: 0,
      skipped,
      updates: [],
      message: "The LLM did not return any new summaries.",
    });
  }

  try {
    await own.client.batchUpdateValues({
      accessToken: own.accessToken,
      spreadsheetId: own.spreadsheetId,
      // One summary cell per enriched row, written in a single request.
      data: updates.map((update) => ({
        range: shelfSummaryRange(own.sheetTabName, update.rowIndex),
        values: [[update.summary]],
      })),
    });
  } catch (error) {
    return googleSheetsErrorResponse(error);
  }

  // Summaries are written, so meter one batch rate per enriched book. Best-effort
  // so a metering hiccup never turns a successful enrichment into an error.
  try {
    const rate = rateForAction(
      resolveCreditRates(env),
      CREDIT_ACTION_BATCH_BOOK_SUMMARY,
    );
    await recordUsage(env.DB, user.id, {
      action: CREDIT_ACTION_BATCH_BOOK_SUMMARY,
      amount: rate * updates.length,
    });
  } catch (error) {
    console.warn(
      "[credits] usage metering failed:",
      error instanceof Error ? error.message : error,
    );
  }

  // Summaries changed, so drop this owner's cached shared read immediately.
  await invalidateSharedShelfCache(env, {
    userId: user.id,
    spreadsheetId: own.spreadsheetId,
    sheetTabName: own.sheetTabName,
  });

  return jsonResponse({
    ok: true,
    total: rows.length,
    enriched: updates.length,
    skipped,
    updates,
  });
};
