import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  buildInvitePath,
  regenerateInviteToken,
  RotateGroupTokenSchema,
} from "../../../lib/groups";
import { errorResponse, jsonResponse } from "../../../lib/http";

export const prerender = false;

/**
 * Regenerate a group's invite token. Only the group's admin may do so. The old
 * token stops matching immediately for new joins and views, while existing
 * `active` members are untouched. The response returns the new invite path.
 */
export const POST: APIRoute = async (context) => {
  const user = context.locals.user;
  if (!user) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to manage a group.");
  }

  let payload: unknown;
  try {
    payload = await context.request.json();
  } catch {
    return errorResponse(400, "INVALID_REQUEST", "Request body must be valid JSON.");
  }

  const parsed = RotateGroupTokenSchema.safeParse(payload);
  if (!parsed.success) {
    return errorResponse(400, "INVALID_REQUEST", "Provide the groupId to regenerate.");
  }

  const token = await regenerateInviteToken(env.DB, {
    groupId: parsed.data.groupId,
    adminUserId: user.id,
  });
  if (!token) {
    return errorResponse(
      403,
      "NOT_GROUP_ADMIN",
      "Only this group's admin can regenerate its invite link.",
    );
  }

  return jsonResponse({ ok: true, invitePath: buildInvitePath(token) });
};
