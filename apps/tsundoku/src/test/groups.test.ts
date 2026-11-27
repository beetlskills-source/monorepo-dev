import { describe, expect, it } from "vitest";
import {
  buildInvitePath,
  createGroup,
  exitGroup,
  findGroupByInviteToken,
  isActiveMember,
  listActiveGroupIds,
  listCommonActiveGroupIds,
  listGroupMembers,
  listGroupsForUser,
  listInvitationsForUser,
  recordInvitationFromToken,
  regenerateInviteToken,
  removeGroupMember,
  respondToInvitation,
} from "../lib/groups";

interface RunRecord {
  sql: string;
  args: unknown[];
}

/** Minimal D1 double whose reads are routed by SQL and whose writes are logged. */
function createFakeDb(
  handlers: {
    first?: (sql: string, args: unknown[]) => unknown;
    all?: (sql: string, args: unknown[]) => unknown[];
  } = {},
) {
  const runs: RunRecord[] = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        args: [] as unknown[],
        bind(...args: unknown[]) {
          statement.args = args;
          return statement;
        },
        async first() {
          return handlers.first?.(sql, statement.args) ?? null;
        },
        async all() {
          return { results: handlers.all?.(sql, statement.args) ?? [] };
        },
        async run() {
          runs.push({ sql, args: statement.args });
          return { success: true };
        },
      };
      return statement;
    },
    /** Mirror D1's ordered batch: run each prepared statement in sequence. */
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      const results: unknown[] = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      return results;
    },
  };
  return { db: db as unknown as D1Database, runs };
}

const groupRow = {
  id: "group-1",
  name: "Book Club",
  admin_user_id: "admin-1",
  invite_token: "token-abc",
  invite_token_updated_at: "2026-01-01T00:00:00.000Z",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

describe("buildInvitePath", () => {
  it("builds a root-relative invite link with the token encoded", () => {
    expect(buildInvitePath("token-abc")).toBe("/?invite=token-abc");
    expect(buildInvitePath("a b/c")).toBe("/?invite=a%20b%2Fc");
  });
});

describe("createGroup", () => {
  it("inserts the group and an active admin membership", async () => {
    const { db, runs } = createFakeDb();
    const group = await createGroup(db, { name: "Book Club", adminUserId: "u-1" });

    expect(group.name).toBe("Book Club");
    expect(group.adminUserId).toBe("u-1");
    expect(group.inviteToken.length).toBeGreaterThan(0);

    const groupInsert = runs.find((run) => run.sql.includes('INSERT INTO "groups"'));
    expect(groupInsert?.args[1]).toBe("Book Club");
    expect(groupInsert?.args[2]).toBe("u-1");
    expect(groupInsert?.args[3]).toBe(group.inviteToken);

    const memberInsert = runs.find((run) =>
      run.sql.includes("INSERT INTO group_memberships"),
    );
    expect(memberInsert?.sql).toContain("'admin', 'active'");
    expect(memberInsert?.args).toContain("u-1");
  });
});

describe("findGroupByInviteToken", () => {
  it("maps a matching row and returns null for an unknown/rotated token", async () => {
    const found = createFakeDb({ first: () => groupRow });
    await expect(
      findGroupByInviteToken(found.db, "token-abc"),
    ).resolves.toMatchObject({ id: "group-1", inviteToken: "token-abc" });

    const missing = createFakeDb({ first: () => null, all: () => [] });
    await expect(findGroupByInviteToken(missing.db, "stale")).resolves.toBeNull();
  });
});

describe("listGroupsForUser", () => {
  it("exposes the invite token only to the group's admin", async () => {
    const { db } = createFakeDb({
      all: () => [
        {
          id: "group-1",
          name: "Book Club",
          role: "admin",
          invite_token: "token-abc",
          member_count: 2,
        },
        {
          id: "group-2",
          name: "Sci-Fi",
          role: "member",
          invite_token: "token-xyz",
          member_count: 5,
        },
      ],
    });

    const groups = await listGroupsForUser(db, "u-1");
    expect(groups).toEqual([
      {
        id: "group-1",
        name: "Book Club",
        role: "admin",
        isAdmin: true,
        memberCount: 2,
        inviteToken: "token-abc",
      },
      {
        id: "group-2",
        name: "Sci-Fi",
        role: "member",
        isAdmin: false,
        memberCount: 5,
        inviteToken: null,
      },
    ]);
  });
});

describe("group id lookups", () => {
  it("lists the caller's active groups", async () => {
    const { db } = createFakeDb({
      all: () => [{ group_id: "g-1" }, { group_id: "g-2" }],
    });
    await expect(listActiveGroupIds(db, "u-1")).resolves.toEqual(["g-1", "g-2"]);
  });

  it("intersects the viewer's and owner's active groups", async () => {
    const { db } = createFakeDb({ all: () => [{ group_id: "g-shared" }] });
    await expect(
      listCommonActiveGroupIds(db, "viewer", "owner"),
    ).resolves.toEqual(["g-shared"]);
  });
});

describe("isActiveMember", () => {
  it("is true only for an active membership", async () => {
    const active = createFakeDb({ first: () => ({ status: "active" }) });
    await expect(isActiveMember(active.db, "g-1", "u-1")).resolves.toBe(true);

    const left = createFakeDb({ first: () => ({ status: "left" }) });
    await expect(isActiveMember(left.db, "g-1", "u-1")).resolves.toBe(false);

    const none = createFakeDb({ first: () => null });
    await expect(isActiveMember(none.db, "g-1", "u-1")).resolves.toBe(false);
  });
});

describe("regenerateInviteToken", () => {
  it("returns null when the caller is not the group's admin", async () => {
    const { db, runs } = createFakeDb({ first: () => null });
    await expect(
      regenerateInviteToken(db, { groupId: "g-1", adminUserId: "not-admin" }),
    ).resolves.toBeNull();
    expect(runs).toHaveLength(0);
  });

  it("rotates the token for the admin without touching memberships", async () => {
    const { db, runs } = createFakeDb({ first: () => ({ id: "g-1" }) });
    const token = await regenerateInviteToken(db, {
      groupId: "g-1",
      adminUserId: "admin-1",
    });
    expect(typeof token).toBe("string");
    expect(token).not.toBe("");

    const update = runs.find((run) => run.sql.includes('UPDATE "groups" SET invite_token'));
    expect(update?.args).toContain(token);
    expect(update?.args).toContain("g-1");
    expect(runs.some((run) => run.sql.includes("group_memberships"))).toBe(false);
  });
});

describe("listInvitationsForUser", () => {
  it("maps invitations tied to the group's current token", async () => {
    const { db } = createFakeDb({
      all: (_sql) => [
        {
          id: "inv-1",
          group_id: "g-1",
          group_name: "Book Club",
          inviter_email: "admin@example.com",
          status: "pending",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const invitations = await listInvitationsForUser(db, "u-1");
    expect(invitations).toEqual([
      {
        id: "inv-1",
        groupId: "g-1",
        groupName: "Book Club",
        inviterEmail: "admin@example.com",
        status: "pending",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("ignores stale rows via the token match in SQL", async () => {
    let seen = "";
    const { db } = createFakeDb({
      all: (sql) => {
        seen = sql;
        return [];
      },
    });
    await listInvitationsForUser(db, "u-1");
    expect(seen).toContain("i.token_used = g.invite_token");
    expect(seen).toContain("i.status != 'removed'");
  });
});

describe("recordInvitationFromToken", () => {
  it("rejects an unknown or rotated token without leaking group details", async () => {
    const { db, runs } = createFakeDb({
      first: (sql) => (sql.includes('FROM "groups"') ? null : null),
    });
    await expect(
      recordInvitationFromToken(db, { userId: "u-1", token: "stale" }),
    ).resolves.toEqual({ outcome: "invalid" });
    expect(runs).toHaveLength(0);
  });

  it("rejects reuse of a removed invitation's token", async () => {
    const { db, runs } = createFakeDb({
      first: (sql) => {
        if (sql.includes('FROM "groups"')) return groupRow;
        if (sql.includes("FROM group_invitations")) {
          return { id: "inv-1", status: "removed" };
        }
        return null;
      },
    });
    await expect(
      recordInvitationFromToken(db, { userId: "u-1", token: "token-abc" }),
    ).resolves.toEqual({ outcome: "rejected" });
    expect(runs).toHaveLength(0);
  });

  it("keeps an existing invitation's stored state", async () => {
    const { db, runs } = createFakeDb({
      first: (sql) => {
        if (sql.includes('FROM "groups"')) return groupRow;
        if (sql.includes("FROM group_invitations")) {
          return { id: "inv-1", status: "ignored" };
        }
        return null;
      },
    });
    await expect(
      recordInvitationFromToken(db, { userId: "u-1", token: "token-abc" }),
    ).resolves.toEqual({ outcome: "recorded", status: "ignored" });
    expect(runs).toHaveLength(0);
  });

  it("seeds a pending invitation for a non-member", async () => {
    const { db, runs } = createFakeDb({
      first: (sql) => {
        if (sql.includes('FROM "groups"')) return groupRow;
        if (sql.includes("FROM group_invitations")) return null;
        if (sql.includes("FROM group_memberships")) return { status: "left" };
        return null;
      },
    });
    await expect(
      recordInvitationFromToken(db, { userId: "u-1", token: "token-abc" }),
    ).resolves.toEqual({ outcome: "recorded", status: "pending" });

    const insert = runs.find((run) => run.sql.includes("INSERT INTO group_invitations"));
    expect(insert?.args).toContain("pending");
    expect(insert?.args).toContain("token-abc");
  });

  it("seeds an accepted invitation for an existing active member", async () => {
    const { db } = createFakeDb({
      first: (sql) => {
        if (sql.includes('FROM "groups"')) return groupRow;
        if (sql.includes("FROM group_invitations")) return null;
        if (sql.includes("FROM group_memberships")) return { status: "active" };
        return null;
      },
    });
    await expect(
      recordInvitationFromToken(db, { userId: "u-1", token: "token-abc" }),
    ).resolves.toEqual({ outcome: "recorded", status: "accepted" });
  });
});

describe("respondToInvitation", () => {
  const invitation = { id: "inv-1", group_id: "g-1", status: "pending" };

  it("returns false when the invitation is not the caller's or rotated away", async () => {
    const { db, runs } = createFakeDb({ first: () => null });
    await expect(
      respondToInvitation(db, {
        invitationId: "inv-x",
        userId: "u-1",
        action: "accept",
      }),
    ).resolves.toBe(false);
    expect(runs).toHaveLength(0);
  });

  it("accepts: upserts an active membership and marks it accepted", async () => {
    const { db, runs } = createFakeDb({ first: () => invitation });
    await expect(
      respondToInvitation(db, { invitationId: "inv-1", userId: "u-1", action: "accept" }),
    ).resolves.toBe(true);

    const membership = runs.find((run) => run.sql.includes("INSERT INTO group_memberships"));
    expect(membership?.sql).toContain("ON CONFLICT(group_id, user_id)");
    expect(membership?.sql).toContain("status = 'active'");

    const update = runs.find((run) => run.sql.includes("UPDATE group_invitations"));
    expect(update?.args).toContain("accepted");
  });

  it("ignores: marks it ignored without joining the group", async () => {
    const { db, runs } = createFakeDb({ first: () => invitation });
    await expect(
      respondToInvitation(db, { invitationId: "inv-1", userId: "u-1", action: "ignore" }),
    ).resolves.toBe(true);
    expect(runs.some((run) => run.sql.includes("group_memberships"))).toBe(false);
    expect(runs.find((run) => run.sql.includes("UPDATE group_invitations"))?.args).toContain(
      "ignored",
    );
  });

  it("removes: marks it removed so it clears from the list", async () => {
    const { db, runs } = createFakeDb({ first: () => invitation });
    await expect(
      respondToInvitation(db, { invitationId: "inv-1", userId: "u-1", action: "remove" }),
    ).resolves.toBe(true);
    expect(runs.find((run) => run.sql.includes("UPDATE group_invitations"))?.args).toContain(
      "removed",
    );
  });
});

describe("exitGroup", () => {
  it("returns null and writes nothing when the caller is not an active member", async () => {
    const { db, runs } = createFakeDb({ first: () => null });
    await expect(
      exitGroup(db, { groupId: "g-1", userId: "u-1" }),
    ).resolves.toBeNull();
    expect(runs).toHaveLength(0);
  });

  it("member: removes only the caller's own membership record", async () => {
    const { db, runs } = createFakeDb({ first: () => ({ role: "member" }) });
    await expect(
      exitGroup(db, { groupId: "g-1", userId: "u-1" }),
    ).resolves.toBe("left");

    expect(runs).toHaveLength(1);
    expect(runs[0]?.sql).toContain("DELETE FROM group_memberships");
    expect(runs[0]?.args).toEqual(["g-1", "u-1"]);
    // The group, its invitations, and every other member are untouched.
    expect(runs.some((run) => run.sql.includes('DELETE FROM "groups"'))).toBe(false);
    expect(runs.some((run) => run.sql.includes("group_invitations"))).toBe(false);
  });

  it("admin: cascades invitations, memberships, then the group row", async () => {
    const { db, runs } = createFakeDb({ first: () => ({ role: "admin" }) });
    await expect(
      exitGroup(db, { groupId: "g-1", userId: "admin-1" }),
    ).resolves.toBe("deleted");

    expect(runs.map((run) => run.sql)).toEqual([
      "DELETE FROM group_invitations WHERE group_id = ?",
      "DELETE FROM group_memberships WHERE group_id = ?",
      'DELETE FROM "groups" WHERE id = ?',
    ]);
    expect(runs.every((run) => run.args[0] === "g-1")).toBe(true);
  });
});

describe("listGroupMembers", () => {
  it("maps active members with resolved role and name/email", async () => {
    const { db } = createFakeDb({
      all: (sql) => {
        expect(sql).toContain("m.status = 'active'");
        return [
          {
            user_id: "admin-1",
            role: "admin",
            name: "Ada",
            email: "ada@example.com",
          },
          {
            user_id: "u-2",
            role: "member",
            name: null,
            email: "bob@example.com",
          },
        ];
      },
    });

    await expect(listGroupMembers(db, "g-1")).resolves.toEqual([
      {
        userId: "admin-1",
        name: "Ada",
        email: "ada@example.com",
        role: "admin",
        isAdmin: true,
      },
      {
        userId: "u-2",
        name: null,
        email: "bob@example.com",
        role: "member",
        isAdmin: false,
      },
    ]);
  });
});

describe("removeGroupMember", () => {
  it("refuses a requester who is not the group's admin", async () => {
    const { db, runs } = createFakeDb({ first: () => null });
    await expect(
      removeGroupMember(db, {
        groupId: "g-1",
        requesterId: "not-admin",
        targetUserId: "u-2",
      }),
    ).resolves.toBe("not_admin");
    expect(runs).toHaveLength(0);
  });

  it("never removes the admin row itself", async () => {
    const { db, runs } = createFakeDb({
      first: (sql) =>
        sql.includes('FROM "groups"') ? { id: "g-1" } : { role: "admin" },
    });
    await expect(
      removeGroupMember(db, {
        groupId: "g-1",
        requesterId: "admin-1",
        targetUserId: "admin-1",
      }),
    ).resolves.toBe("not_member");
    expect(runs).toHaveLength(0);
  });

  it("removes a non-admin member's active membership record", async () => {
    const { db, runs } = createFakeDb({
      first: (sql) =>
        sql.includes('FROM "groups"') ? { id: "g-1" } : { role: "member" },
    });
    await expect(
      removeGroupMember(db, {
        groupId: "g-1",
        requesterId: "admin-1",
        targetUserId: "u-2",
      }),
    ).resolves.toBe("removed");

    expect(runs).toHaveLength(1);
    expect(runs[0]?.sql).toContain("DELETE FROM group_memberships");
    expect(runs[0]?.args).toEqual(["g-1", "u-2"]);
    // The group, its invitations, and other members are untouched.
    expect(runs.some((run) => run.sql.includes('DELETE FROM "groups"'))).toBe(false);
    expect(runs.some((run) => run.sql.includes("group_invitations"))).toBe(false);
  });
});
