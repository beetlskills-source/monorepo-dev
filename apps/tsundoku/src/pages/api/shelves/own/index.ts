import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { loadOwnShelf } from "../../../../lib/shelves";
import { errorResponse, jsonResponse } from "../../../../lib/http";

export const prerender = false;

/**
 * Read the signed-in user's own shelf rows (OWNER). Used by the dashboard to
 * re-render the table after an edit or delete without a full page reload.
 * Returns the same `OwnShelfView` shape the SSR page renders, so empty,
 * unlinked, and error states stay consistent across the initial render and
 * later refreshes.
 */
export const GET: APIRoute = async (context) => {
  const user = context.locals.user;
  if (!user) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to view your shelf.");
  }

  const view = await loadOwnShelf(env, user.id);
  return jsonResponse(view);
};
