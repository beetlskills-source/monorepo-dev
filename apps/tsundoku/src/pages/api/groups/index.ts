import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  buildInvitePath,
  CreateGroupRequestSchema,
  createGroup,
  listGroupsForUser,
} from "../../../lib/groups";
import { errorResponse, jsonResponse } from "../../../lib/http";

export const prerender = false;

/**
 * List the signed-in user's groups (the groups they are an `active` member of).
 * Scoped strictly to the caller — there is no endpoint that lists other users or
 * every group, so no public directory is ever exposed.
 */
export const GET: APIRoute = async (context) => {
  const user = context.locals.user;
  if (!user) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to view your groups.");
  }

  const groups = await listGroupsForUser(env.DB, user.id);
  return jsonResponse({ ok: true, groups });
};

/**
 * Create a named group. Any authenticated user may create one and becomes its
 * `active` `admin`. The response includes the shareable invite path (a fresh
 * token) so the creator can hand out the invite immediately.
 */
export const POST: APIRoute = async (context) => {
  const user = context.locals.user;
  if (!user) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to create a group.");
  }

  let payload: unknown;
  try {
    payload = await context.request.json();
  } catch {
    return errorResponse(400, "INVALID_REQUEST", "Request body must be valid JSON.");
  }

  const parsed = CreateGroupRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      "Provide a group name between 1 and 80 characters.",
    );
  }

  const group = await createGroup(env.DB, {
    name: parsed.data.name,
    adminUserId: user.id,
  });

  return jsonResponse(
    {
      ok: true,
      group: {
        id: group.id,
        name: group.name,
        role: "admin",
        isAdmin: true,
        memberCount: 1,
      },
      invitePath: buildInvitePath(group.inviteToken),
    },
    201,
  );
};
