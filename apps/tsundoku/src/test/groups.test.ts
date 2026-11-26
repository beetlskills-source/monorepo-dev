import { describe, expect, it } from "vitest";
import {
  buildInvitePath,
  createGroup,
  findGroupByInviteToken,
  isActiveMember,
  listActiveGroupIds,
  listCommonActiveGroupIds,
  listGroupsForUser,
  listInvitationsForUser,
  recordInvitationFromToken,
  regenerateInviteToken,
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
