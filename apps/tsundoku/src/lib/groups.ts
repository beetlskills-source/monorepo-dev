/**
 * D1 accessors and helpers for Phase 5 groups, memberships, and invitations.
 *
 * These back the three-level visibility model (membership -> sheet ->
 * row/item) and the group-scoped ownership transfers. Every function takes the
 * `D1Database` binding so the helpers stay a pure function of the current
 * request's environment, and none of them ever list all users or groups — each
 * lookup is scoped to the caller or a single invite token.
 *
 * Row-level group targeting itself lives in the canonical Google Sheet `groups`
 * column (comma-separated group ids); D1 only tracks membership and the
 * per-user invitation state.
 */

import { z } from "zod";
import { createRandomToken } from "./sheet-flow";

export type GroupRole = "admin" | "member";
export type MembershipStatus = "active" | "left" | "removed";
export type InvitationStatus = "pending" | "accepted" | "ignored" | "removed";

/** Query parameter carrying an invite token (e.g. `/?invite=<token>`). */
export const GROUP_INVITE_QUERY_PARAM = "invite";

/** A group as stored in D1 (invite token included; server-side only). */
export interface Group {
  id: string;
  name: string;
  adminUserId: string;
  inviteToken: string;
  inviteTokenUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
}

/** A group the signed-in user belongs to, with their role and member count. */
export interface GroupSummary {
  id: string;
  name: string;
  role: GroupRole;
  isAdmin: boolean;
  memberCount: number;
  /**
   * The group's current invite token, exposed only to its admin (else `null`),
   * so members cannot hand out or rotate invites.
   */
  inviteToken: string | null;
}

/** One active member of a group, resolved for the membership view. */
export interface GroupMemberView {
  userId: string;
  name: string | null;
  email: string | null;
  role: GroupRole;
  isAdmin: boolean;
}

/** A single user-specific invitation, resolved for the invitation inbox. */
export interface GroupInvitationView {
  id: string;
  groupId: string;
  groupName: string;
  /** Email of the group's admin (the inviter); `null` when unavailable. */
  inviterEmail: string | null;
  status: InvitationStatus;
  createdAt: string;
}

/** Outcome of recording an invite link a signed-in user just opened. */
export type RecordInvitationOutcome =
  | { outcome: "recorded"; status: InvitationStatus }
  | { outcome: "invalid" }
  | { outcome: "rejected" };

export type InvitationResponseAction = "accept" | "ignore" | "remove";

export interface GroupRow {
  id: string;
  name: string;
  admin_user_id: string;
  invite_token: string;
  invite_token_updated_at: string;
  created_at: string;
  updated_at: string;
}

function mapGroup(row: GroupRow): Group {
  return {
    id: row.id,
    name: row.name,
    adminUserId: row.admin_user_id,
    inviteToken: row.invite_token,
    inviteTokenUpdatedAt: row.invite_token_updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Relative invite path an admin can share (token is opaque and rotatable). */
export function buildInvitePath(token: string): string {
  return `/?${GROUP_INVITE_QUERY_PARAM}=${encodeURIComponent(token)}`;
}

/**
 * Create a named group and insert its creator as an `active` `admin` member.
 * Returns the new group (including its first invite token).
 */
export async function createGroup(
  db: D1Database,
  input: { name: string; adminUserId: string },
): Promise<Group> {
  const id = crypto.randomUUID();
  const token = createRandomToken(24);
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO "groups" (id, name, admin_user_id, invite_token, invite_token_updated_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.name, input.adminUserId, token, now, now, now)
    .run();

  await db
    .prepare(
      `INSERT INTO group_memberships (group_id, user_id, role, status, joined_at, updated_at)
       VALUES (?, ?, 'admin', 'active', ?, ?)`,
    )
    .bind(id, input.adminUserId, now, now)
    .run();

  return {
    id,
    name: input.name,
    adminUserId: input.adminUserId,
    inviteToken: token,
    inviteTokenUpdatedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Resolve a group from an invite token. Returns `null` for an unknown or
 * rotated token, so callers never leak group details to an invalid link.
 */
export async function findGroupByInviteToken(
  db: D1Database,
  token: string,
): Promise<Group | null> {
  const row = await db
    .prepare(
      `SELECT id, name, admin_user_id, invite_token, invite_token_updated_at, created_at, updated_at
         FROM "groups"
        WHERE invite_token = ?
        LIMIT 1`,
    )
    .bind(token)
    .first<GroupRow>();
  return row ? mapGroup(row) : null;
}

/** List the groups the user is an `active` member of, ordered by name. */
export async function listGroupsForUser(
  db: D1Database,
  userId: string,
): Promise<GroupSummary[]> {
  const result = await db
    .prepare(
      `SELECT g.id AS id, g.name AS name, m.role AS role, g.invite_token AS invite_token,
              (SELECT COUNT(*) FROM group_memberships c
                WHERE c.group_id = g.id AND c.status = 'active') AS member_count
         FROM group_memberships m
         JOIN "groups" g ON g.id = m.group_id
        WHERE m.user_id = ? AND m.status = 'active'
        ORDER BY g.name`,
    )
    .bind(userId)
    .all<{
      id: string;
      name: string;
      role: string;
      invite_token: string;
      member_count: number;
    }>();

  const rows = result?.results ?? [];
  return rows.map((row) => {
    const isAdmin = row.role === "admin";
    return {
      id: row.id,
      name: row.name,
      role: isAdmin ? "admin" : "member",
      isAdmin,
      memberCount: Number(row.member_count ?? 0),
      inviteToken: isAdmin ? row.invite_token : null,
    };
  });
}

/** The ids of the groups the user is an `active` member of. */
export async function listActiveGroupIds(
  db: D1Database,
  userId: string,
): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT group_id FROM group_memberships WHERE user_id = ? AND status = 'active'`,
    )
    .bind(userId)
    .all<{ group_id: string }>();
  return (result?.results ?? []).map((row) => row.group_id);
}

/**
 * The active groups the viewer and the owner share. Row-level visibility is
 * decided against exactly this intersection, so a stale or one-sided membership
 * can never widen what a viewer sees.
 */
export async function listCommonActiveGroupIds(
  db: D1Database,
  viewerId: string,
  ownerId: string,
): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT me.group_id AS group_id
         FROM group_memberships me
         JOIN group_memberships them ON them.group_id = me.group_id
        WHERE me.user_id = ? AND me.status = 'active'
          AND them.user_id = ? AND them.status = 'active'`,
    )
    .bind(viewerId, ownerId)
    .all<{ group_id: string }>();
  return (result?.results ?? []).map((row) => row.group_id);
}

/** True when the user is an `active` member of the group. */
export async function isActiveMember(
  db: D1Database,
  groupId: string,
  userId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT status FROM group_memberships WHERE group_id = ? AND user_id = ? LIMIT 1`,
    )
    .bind(groupId, userId)
    .first<{ status: string }>();
  return row?.status === "active";
}

/**
 * List a group's `active` members (admins first), resolving each member's
 * display name/email from the auth `user` table. Callers must confirm the
 * requester is a member before exposing this roster.
 */
export async function listGroupMembers(
  db: D1Database,
  groupId: string,
): Promise<GroupMemberView[]> {
  const result = await db
    .prepare(
      `SELECT m.user_id AS user_id, m.role AS role,
              u.name AS name, u.email AS email
         FROM group_memberships m
         LEFT JOIN "user" u ON u.id = m.user_id
        WHERE m.group_id = ? AND m.status = 'active'
        ORDER BY CASE m.role WHEN 'admin' THEN 0 ELSE 1 END, u.name, u.email`,
    )
    .bind(groupId)
    .all<{
      user_id: string;
      role: string;
      name: string | null;
      email: string | null;
    }>();

  return (result?.results ?? []).map((row) => ({
    userId: row.user_id,
    name: row.name ?? null,
    email: row.email ?? null,
    role: row.role === "admin" ? "admin" : "member",
    isAdmin: row.role === "admin",
  }));
}

/**
 * Rotate a group's invite token. Only the group's admin may do so. The old
 * token stops matching immediately (it is no longer the row's `invite_token`),
 * while existing `active` memberships are untouched. Returns the new token, or
 * `null` when the caller is not the group's admin.
 */
export async function regenerateInviteToken(
  db: D1Database,
  input: { groupId: string; adminUserId: string },
): Promise<string | null> {
  const existing = await db
    .prepare(
      `SELECT id FROM "groups" WHERE id = ? AND admin_user_id = ? LIMIT 1`,
    )
    .bind(input.groupId, input.adminUserId)
    .first<{ id: string }>();
  if (!existing) return null;

  const token = createRandomToken(24);
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE "groups" SET invite_token = ?, invite_token_updated_at = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(token, now, now, input.groupId)
    .run();
  return token;
}

interface InvitationRow {
  id: string;
  group_id: string;
  group_name: string;
  inviter_email: string | null;
  status: string;
  created_at: string;
}

function mapInvitation(row: InvitationRow): GroupInvitationView {
  return {
    id: row.id,
    groupId: row.group_id,
    groupName: row.group_name,
    inviterEmail: row.inviter_email ?? null,
    status: row.status as InvitationStatus,
    createdAt: row.created_at,
  };
}

/**
 * Every invitation for the user that is still tied to its group's *current*
 * token (a rotated token hides its stale invitations) and not `removed`.
 */
export async function listInvitationsForUser(
  db: D1Database,
  userId: string,
): Promise<GroupInvitationView[]> {
  const result = await db
    .prepare(
      `SELECT i.id AS id, i.group_id AS group_id, g.name AS group_name,
              u.email AS inviter_email, i.status AS status, i.created_at AS created_at
         FROM group_invitations i
         JOIN "groups" g ON g.id = i.group_id
         LEFT JOIN "user" u ON u.id = g.admin_user_id
        WHERE i.user_id = ?
          AND i.status != 'removed'
          AND i.token_used = g.invite_token
        ORDER BY i.created_at DESC`,
    )
    .bind(userId)
    .all<InvitationRow>();
  return (result?.results ?? []).map(mapInvitation);
}

/**
 * Record the invite link a signed-in user just opened.
 *
 * - An unknown/rotated token is `invalid` (no group details leak).
 * - A previously `removed` invitation rejects reuse of the same token until the
 *   admin regenerates it.
 * - An existing `pending`/`ignored`/`accepted` invitation keeps its stored
 *   state, so ignoring then reopening does not resurrect an active alert.
 */
export async function recordInvitationFromToken(
  db: D1Database,
  input: { userId: string; token: string },
): Promise<RecordInvitationOutcome> {
  const group = await findGroupByInviteToken(db, input.token);
  if (!group) return { outcome: "invalid" };

  const existing = await db
    .prepare(
      `SELECT id, status FROM group_invitations
        WHERE group_id = ? AND user_id = ? AND token_used = ? LIMIT 1`,
    )
    .bind(group.id, input.userId, input.token)
    .first<{ id: string; status: string }>();

  if (existing) {
    if (existing.status === "removed") return { outcome: "rejected" };
    return { outcome: "recorded", status: existing.status as InvitationStatus };
  }

  const status: InvitationStatus = (await isActiveMember(
    db,
    group.id,
    input.userId,
  ))
    ? "accepted"
    : "pending";
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO group_invitations (id, group_id, user_id, token_used, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      group.id,
      input.userId,
      input.token,
      status,
      now,
      now,
    )
    .run();
  return { outcome: "recorded", status };
}

/** Load the user's invitation when it is still tied to the group's token. */
async function getRespondableInvitation(
  db: D1Database,
  invitationId: string,
  userId: string,
): Promise<{ id: string; group_id: string; status: string } | null> {
  const row = await db
    .prepare(
      `SELECT i.id AS id, i.group_id AS group_id, i.status AS status
         FROM group_invitations i
         JOIN "groups" g ON g.id = i.group_id
        WHERE i.id = ? AND i.user_id = ?
          AND i.token_used = g.invite_token
          AND i.status != 'removed'
        LIMIT 1`,
    )
    .bind(invitationId, userId)
    .first<{ id: string; group_id: string; status: string }>();
  return row ?? null;
}

/**
 * Respond to one of the user's invitations.
 *
 * - `accept` upserts an `active` membership and marks the invitation
 *   `accepted`. An existing admin role is preserved.
 * - `ignore` marks it `ignored` (hidden from active alerts, still listed).
 * - `remove` marks it `removed` so it drops off the list and the same token is
 *   rejected until the admin regenerates it.
 *
 * Returns `false` when the invitation is not the user's or its token rotated.
 */
export async function respondToInvitation(
  db: D1Database,
  input: { invitationId: string; userId: string; action: InvitationResponseAction },
): Promise<boolean> {
  const invitation = await getRespondableInvitation(
    db,
    input.invitationId,
    input.userId,
  );
  if (!invitation) return false;

  const now = new Date().toISOString();
  const nextStatus: InvitationStatus =
    input.action === "accept"
      ? "accepted"
      : input.action === "ignore"
        ? "ignored"
        : "removed";

  if (input.action === "accept") {
    await db
      .prepare(
        `INSERT INTO group_memberships (group_id, user_id, role, status, joined_at, updated_at)
         VALUES (?, ?, 'member', 'active', ?, ?)
         ON CONFLICT(group_id, user_id)
         DO UPDATE SET status = 'active', updated_at = excluded.updated_at`,
      )
      .bind(invitation.group_id, input.userId, now, now)
      .run();
  }

  await db
    .prepare(
      `UPDATE group_invitations SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
    )
    .bind(nextStatus, now, input.invitationId, input.userId)
    .run();

  return true;
}

/** Result of the caller leaving a group (or deleting it as its admin). */
export type ExitGroupOutcome = "left" | "deleted";

/**
 * Delete a group and everything scoped to it. D1 has no interactive
 * transaction helper, so the deletes run as one ordered `batch` (an implicit
 * transaction): pending invitations first, then memberships, then the group row
 * last — the row's own `invite_token` is the invite link, so removing the row
 * also retires every shared link. Row-level group tags live in each member's
 * Google Sheet and are intentionally left alone (personal books are never
 * deleted); they become inert because visibility is always resolved against
 * active co-membership, which this removes.
 */
async function deleteGroupCascade(db: D1Database, groupId: string): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM group_invitations WHERE group_id = ?`).bind(groupId),
    db.prepare(`DELETE FROM group_memberships WHERE group_id = ?`).bind(groupId),
    db.prepare(`DELETE FROM "groups" WHERE id = ?`).bind(groupId),
  ]);
}

/**
 * Exit a group, or — when the caller is its admin — delete it outright.
 *
 * - A `member` removes only their own membership record, so the group and every
 *   other member stay intact.
 * - An `admin` triggers the full cascade (invitations, memberships, the group
 *   row and its invite token) for everyone, as if the group never existed.
 *
 * The role is resolved from the caller's own active membership, so a member can
 * never trigger a group-wide deletion. Returns `null` when the caller is not an
 * active member, so a stale or forged groupId mutates nothing.
 */
export async function exitGroup(
  db: D1Database,
  input: { groupId: string; userId: string },
): Promise<ExitGroupOutcome | null> {
  const membership = await db
    .prepare(
      `SELECT role FROM group_memberships
        WHERE group_id = ? AND user_id = ? AND status = 'active'
        LIMIT 1`,
    )
    .bind(input.groupId, input.userId)
    .first<{ role: string }>();
  if (!membership) return null;

  if (membership.role === "admin") {
    await deleteGroupCascade(db, input.groupId);
    return "deleted";
  }

  await db
    .prepare(
      `DELETE FROM group_memberships
        WHERE group_id = ? AND user_id = ? AND role = 'member'`,
    )
    .bind(input.groupId, input.userId)
    .run();
  return "left";
}

/** Result of an admin removing one member from their group. */
export type RemoveMemberOutcome = "removed" | "not_admin" | "not_member";

/**
 * Remove one member from a group. Only the group's admin may do so — the same
 * `admin_user_id` check the invite-token rotation uses — and the admin row
 * itself is never removable here: an admin leaves via `exitGroup`, which
 * deletes the whole group. The admin is refused server-side regardless of what
 * the client sends, so a member can never be removed by another member and the
 * admin can never be removed without deleting the group.
 */
export async function removeGroupMember(
  db: D1Database,
  input: { groupId: string; requesterId: string; targetUserId: string },
): Promise<RemoveMemberOutcome> {
  const group = await db
    .prepare(`SELECT id FROM "groups" WHERE id = ? AND admin_user_id = ? LIMIT 1`)
    .bind(input.groupId, input.requesterId)
    .first<{ id: string }>();
  if (!group) return "not_admin";

  const target = await db
    .prepare(
      `SELECT role FROM group_memberships
        WHERE group_id = ? AND user_id = ? AND status = 'active'
        LIMIT 1`,
    )
    .bind(input.groupId, input.targetUserId)
    .first<{ role: string }>();
  if (!target || target.role === "admin") return "not_member";

  await db
    .prepare(
      `DELETE FROM group_memberships
        WHERE group_id = ? AND user_id = ? AND role = 'member'`,
    )
    .bind(input.groupId, input.targetUserId)
    .run();
  return "removed";
}

/** Body for `POST /api/groups`. */
export const CreateGroupRequestSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export type CreateGroupRequest = z.infer<typeof CreateGroupRequestSchema>;

/** Body for `POST /api/groups/token`. */
export const RotateGroupTokenSchema = z.object({
  groupId: z.string().trim().min(1),
});

export type RotateGroupTokenRequest = z.infer<typeof RotateGroupTokenSchema>;

/** Body for `POST /api/invitations/respond`. */
export const InvitationRespondSchema = z.object({
  invitationId: z.string().trim().min(1),
  action: z.enum(["accept", "ignore", "remove"]),
});

export type InvitationRespondRequest = z.infer<typeof InvitationRespondSchema>;

/** Body for `DELETE /api/groups/membership`. */
export const ExitGroupSchema = z.object({
  groupId: z.string().trim().min(1),
});

export type ExitGroupRequest = z.infer<typeof ExitGroupSchema>;

/** Body for `DELETE /api/groups/members`. */
export const RemoveGroupMemberSchema = z.object({
  groupId: z.string().trim().min(1),
  userId: z.string().trim().min(1),
});

export type RemoveGroupMemberRequest = z.infer<typeof RemoveGroupMemberSchema>;
