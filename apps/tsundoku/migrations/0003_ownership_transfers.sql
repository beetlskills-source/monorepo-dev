-- Phase 4: ownership transfer audit log. One row per transfer attempt, recording
-- the sender/recipient, the source and target sheet locations, the book, and
-- the outcome, so a failed or partial transfer stays traceable. Encrypted
-- refresh tokens are never written here.
--
-- `from_user_id` / `to_user_id` are intentionally plain columns (no FK to
-- "user") so the audit trail survives account deletion.

CREATE TABLE IF NOT EXISTS "ownership_transfers" (
  "id" text NOT NULL PRIMARY KEY,
  "from_user_id" text NOT NULL,
  "from_email" text NOT NULL,
  "to_user_id" text NOT NULL,
  "to_email" text NOT NULL,
  "from_spreadsheet_id" text,
  "from_sheet_tab_name" text,
  "to_spreadsheet_id" text,
  "to_sheet_tab_name" text,
  "isbn13" text NOT NULL,
  "title" text,
  "status" text NOT NULL DEFAULT 'pending',
  "error_message" text,
  "created_at" text NOT NULL,
  "completed_at" text
);

CREATE INDEX IF NOT EXISTS "idx_ownership_transfers_from_user" ON "ownership_transfers" ("from_user_id");
CREATE INDEX IF NOT EXISTS "idx_ownership_transfers_to_user" ON "ownership_transfers" ("to_user_id");
CREATE INDEX IF NOT EXISTS "idx_ownership_transfers_isbn13" ON "ownership_transfers" ("isbn13");
