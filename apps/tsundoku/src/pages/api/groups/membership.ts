import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { ExitGroupSchema, exitGroup } from "../../../lib/groups";
import { errorResponse, jsonResponse } from "../../../lib/http";

export const prerender = false;

/**
 * Exit a group. The caller's role is resolved server-side from their own active
 * membership, so the endpoint does the right thing without trusting the client:
 *
 * - a `member` removes only their own membership record (`outcome: "left"`);
 * - an `admin` deletes the whole group for everyone (`outcome: "deleted"`),
 *   cascading invitations, memberships, and the group row with its invite token.
 *
 * A caller who is not an active member changes nothing (404).
 */
export const DELETE: APIRoute = async (context) => {
  const user = context.locals.user;
  if (!user) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to manage your groups.");
  }

  let payload: unknown;
  try {
    payload = await context.request.json();
  } catch {
    return errorResponse(400, "INVALID_REQUEST", "Request body must be valid JSON.");
  }

  const parsed = ExitGroupSchema.safeParse(payload);
  if (!parsed.success) {
    return errorResponse(400, "INVALID_REQUEST", "Provide the groupId to exit.");
  }

  const outcome = await exitGroup(env.DB, {
    groupId: parsed.data.groupId,
    userId: user.id,
  });
  if (!outcome) {
    return errorResponse(
      404,
      "NOT_A_MEMBER",
      "You are no longer an active member of that group. Refresh the dashboard and try again.",
    );
  }

  return jsonResponse({ ok: true, outcome });
};
