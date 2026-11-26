import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { ShelfSettingsRequestSchema } from "../../../lib/sheet-flow";
import { upsertShelfConfig } from "../../../lib/shelf-configs";
import { errorResponse, jsonResponse } from "../../../lib/http";

export const prerender = false;

/**
 * Persist the user's default-visibility and incoming-transfer preferences on
 * their `shelf_configs` row. Creating a row here (via upsert) means the
 * settings survive even before a spreadsheet is connected.
 */
export const POST: APIRoute = async (context) => {
  const user = context.locals.user;
  if (!user) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to change shelf settings.");
  }

  let payload: unknown;
  try {
    payload = await context.request.json();
  } catch {
    return errorResponse(400, "INVALID_REQUEST", "Request body must be valid JSON.");
  }

  const parsed = ShelfSettingsRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      "Provide defaultVisibility ('private' | 'shared') and allowIncomingTransfers (boolean).",
    );
  }

  const config = await upsertShelfConfig(env.DB, user.id, {
    defaultVisibility: parsed.data.defaultVisibility,
    allowIncomingTransfers: parsed.data.allowIncomingTransfers,
  });

  return jsonResponse({
    ok: true,
    config: {
      spreadsheetId: config.spreadsheetId,
      sheetTabName: config.sheetTabName,
      defaultVisibility: config.defaultVisibility,
      allowIncomingTransfers: config.allowIncomingTransfers,
      connected: config.hasRefreshToken,
    },
  });
};
