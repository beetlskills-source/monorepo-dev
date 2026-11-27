import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  isActiveMember,
  listGroupMembers,
  removeGroupMember,
  RemoveGroupMemberSchema,
} from "../../../lib/groups";
import { errorResponse, jsonResponse } from "../../../lib/http";

export const prerender = false;

/**
 * List one group's active members, with each member's role. Only an `active`
 * member of the group may read its roster. The payload also flags whether the
 * caller is the group's admin, so the client knows whether to render the
 * "Remove member" control (admins only).
 */
export const GET: APIRoute = async (context) => {
  const user = context.locals.user;
  if (!user) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to view group members.");
  }

  const groupId = context.url.searchParams.get("groupId")?.trim() ?? "";
  if (!groupId) {
    return errorResponse(400, "INVALID_REQUEST", "Provide a groupId.");
  }
  if (!(await isActiveMember(env.DB, groupId, user.id))) {
    return errorResponse(403, "NOT_A_MEMBER", "You are not a member of that group.");
  }

  const members = await listGroupMembers(env.DB, groupId);
  const viewerIsAdmin = members.some(
    (member) => member.userId === user.id && member.isAdmin,
  );
  return jsonResponse({ ok: true, viewerIsAdmin, members });
};

/**
 * Remove one member from a group. Admin-only, enforced server-side: the
 * requester must be the group's admin (403 otherwise) and the target must be an
 * active non-admin member (404 otherwise). The admin row is never removable
 * here — an admin exits via `DELETE /api/groups/membership`, which deletes the
 * whole group.
 */
export const DELETE: APIRoute = async (context) => {
  const user = context.locals.user;
  if (!user) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to manage group members.");
  }

  let payload: unknown;
  try {
    payload = await context.request.json();
  } catch {
    return errorResponse(400, "INVALID_REQUEST", "Request body must be valid JSON.");
  }

  const parsed = RemoveGroupMemberSchema.safeParse(payload);
  if (!parsed.success) {
    return errorResponse(400, "INVALID_REQUEST", "Provide the groupId and userId.");
  }

  const outcome = await removeGroupMember(env.DB, {
    groupId: parsed.data.groupId,
    requesterId: user.id,
    targetUserId: parsed.data.userId,
  });
  if (outcome === "not_admin") {
    return errorResponse(
      403,
      "NOT_GROUP_ADMIN",
      "Only the group admin can remove members.",
    );
  }
  if (outcome === "not_member") {
    return errorResponse(
      404,
      "MEMBER_NOT_FOUND",
      "That person is no longer a removable member of the group.",
    );
  }

  return jsonResponse({ ok: true, removed: parsed.data.userId });
};
