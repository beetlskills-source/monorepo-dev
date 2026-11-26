-- Phase 5: user-created groups, memberships, and per-user invitations, backing
-- the three-level visibility model (membership -> sheet -> row/item) and the
-- group-scoped ownership transfers.
--
-- Row-level group targeting is stored in the canonical Google Sheet `groups`
-- column (comma-separated group ids), not in D1, so a user's own storage stays
-- sovereign. D1 only tracks who belongs to which group and which invitations
-- each user has seen.
--
-- No table here exposes a public directory of users or groups: every lookup is
-- scoped to the signed-in caller or a single invite token.

CREATE TABLE IF NOT EXISTS "groups" (
  "id" text NOT NULL PRIMARY KEY,
  "name" text NOT NULL,
  "admin_user_id" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  -- The active invite token. Regenerating writes a new random value and bumps
  -- `invite_token_updated_at`, so every previously shared link stops matching.
  "invite_token" text NOT NULL,
  "invite_token_updated_at" text NOT NULL,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "groups_invite_token_idx" ON "groups" ("invite_token");
CREATE INDEX IF NOT EXISTS "groups_admin_user_id_idx" ON "groups" ("admin_user_id");

CREATE TABLE IF NOT EXISTS "group_memberships" (
  "group_id" text NOT NULL REFERENCES "groups" ("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  -- 'admin' | 'member'
  "role" text NOT NULL DEFAULT 'member',
  -- 'active' | 'left' | 'removed'
  "status" text NOT NULL DEFAULT 'active',
  "joined_at" text NOT NULL,
  "updated_at" text NOT NULL,
  PRIMARY KEY ("group_id", "user_id")
);

CREATE INDEX IF NOT EXISTS "group_memberships_user_id_idx" ON "group_memberships" ("user_id");
CREATE INDEX IF NOT EXISTS "group_memberships_group_status_idx" ON "group_memberships" ("group_id", "status");

CREATE TABLE IF NOT EXISTS "group_invitations" (
  "id" text NOT NULL PRIMARY KEY,
  "group_id" text NOT NULL REFERENCES "groups" ("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  -- The invite token this invitation was created from; a regenerated token
  -- produces a fresh invitation row, so a `removed` token stays rejected.
  "token_used" text NOT NULL,
  -- 'pending' | 'accepted' | 'ignored' | 'removed'
  "status" text NOT NULL DEFAULT 'pending',
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "group_invitations_group_user_token_idx"
  ON "group_invitations" ("group_id", "user_id", "token_used");
CREATE INDEX IF NOT EXISTS "group_invitations_user_status_idx" ON "group_invitations" ("user_id", "status");
CREATE INDEX IF NOT EXISTS "group_invitations_token_idx" ON "group_invitations" ("token_used");
