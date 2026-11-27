import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { loadSharedShelves, toPublicSharedShelf } from "../../../lib/shelves";
import { errorResponse, jsonResponse } from "../../../lib/http";

export const prerender = false;

/**
 * Read-only (VIEWER) cross-user view: every *other* user's shelf published for
 * sharing. Each shared shelf is fetched with its owner's stored token, on the
 * server, and rows explicitly marked `private` are filtered out. There is no
 * edit, delete, or transfer surface here — shared shelves stay read-only.
 *
 * The payload is the viewer-safe projection: the owner's spreadsheet id, tab
 * name, and live title are stripped, so a viewer can never locate or open
 * another user's underlying Google Sheet.
 */
export const GET: APIRoute = async (context) => {
  const user = context.locals.user;
  if (!user) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to view shared shelves.");
  }

  const shelves = await loadSharedShelves(env, user.id);
  return jsonResponse({ shelves: shelves.map(toPublicSharedShelf) });
};
