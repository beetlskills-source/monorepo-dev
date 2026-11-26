import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { errorResponse, jsonResponse } from "../../../lib/http";
import { SheetVisibilityRequestSchema } from "../../../lib/sheet-flow";
import { upsertShelfConfig } from "../../../lib/shelf-configs";
import { invalidateSharedShelfCache } from "../../../lib/shelves";

export const prerender = false;

/**
 * Phase 6 Level 2: set whether the signed-in user's *whole* Google Sheet is
 * published to co-members' Shared Shelves. This is intentionally independent of
 * `default_visibility` ("Default visibility for new books"), which only seeds
 * the `visibility` of newly scanned rows. Toggling either one never affects the
 * other.
 */
export const POST: APIRoute = async (context) => {
  const user = context.locals.user;
  if (!user) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to change sharing settings.");
  }

  let payload: unknown;
  try {
    payload = await context.request.json();
  } catch {
    return errorResponse(400, "INVALID_REQUEST", "Request body must be valid JSON.");
  }

  const parsed = SheetVisibilityRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      "Provide sheetVisibility ('private' | 'shared').",
    );
  }

  const config = await upsertShelfConfig(env.DB, user.id, {
    sheetVisibility: parsed.data.sheetVisibility,
  });

  // Level 2 changed: drop this owner's cached shared read so a co-member sees
  // the sheet appear or disappear immediately instead of after the TTL.
  await invalidateSharedShelfCache(env, {
    userId: user.id,
    spreadsheetId: config.spreadsheetId,
    sheetTabName: config.sheetTabName,
  });

  return jsonResponse({ ok: true, sheetVisibility: config.sheetVisibility });
};
