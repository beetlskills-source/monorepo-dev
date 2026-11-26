import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { listInvitationsForUser } from "../../../lib/groups";
import { errorResponse, jsonResponse } from "../../../lib/http";

export const prerender = false;

/**
 * The signed-in user's invitation inbox. Only invitations tied to the group's
 * *current* token appear (a rotated token hides its stale invitations), and
 * `removed` invitations are omitted. Scoped strictly to the caller.
 */
export const GET: APIRoute = async (context) => {
  const user = context.locals.user;
  if (!user) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to view your invitations.");
  }

  const invitations = await listInvitationsForUser(env.DB, user.id);
  return jsonResponse({ ok: true, invitations });
};
