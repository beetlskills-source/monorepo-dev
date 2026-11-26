import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { InvitationRespondSchema, respondToInvitation } from "../../../lib/groups";
import { errorResponse, jsonResponse } from "../../../lib/http";

export const prerender = false;

/**
 * Respond to one of the signed-in user's invitations.
 *
 * - `accept` upserts an `active` membership and marks it `accepted`.
 * - `ignore` marks it `ignored` (hidden from active alerts, still listed).
 * - `remove` marks it `removed` so it drops off the list; the same token is then
 *   rejected until the admin regenerates it.
 *
 * Only the caller's own invitation can be affected, and only while its token is
 * still the group's current token.
 */
export const POST: APIRoute = async (context) => {
  const user = context.locals.user;
  if (!user) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to respond to an invitation.");
  }

  let payload: unknown;
  try {
    payload = await context.request.json();
  } catch {
    return errorResponse(400, "INVALID_REQUEST", "Request body must be valid JSON.");
  }

  const parsed = InvitationRespondSchema.safeParse(payload);
  if (!parsed.success) {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      "Provide an invitationId and an action ('accept' | 'ignore' | 'remove').",
    );
  }

  const handled = await respondToInvitation(env.DB, {
    invitationId: parsed.data.invitationId,
    userId: user.id,
    action: parsed.data.action,
  });
  if (!handled) {
    return errorResponse(
      404,
      "INVITATION_NOT_FOUND",
      "That invitation is no longer available. Refresh the dashboard and try again.",
    );
  }

  return jsonResponse({ ok: true, action: parsed.data.action });
};
