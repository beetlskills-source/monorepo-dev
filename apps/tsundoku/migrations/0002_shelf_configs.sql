-- Phase 2: per-user shelf configuration and encrypted Google refresh token.
-- One row per user. `google_refresh_token_encrypted` holds an AES-GCM payload
-- (see src/lib/crypto.ts); the plaintext token is never written to D1.

CREATE TABLE IF NOT EXISTS "shelf_configs" (
  "user_id" text NOT NULL PRIMARY KEY REFERENCES "user" ("id") ON DELETE CASCADE,
  "spreadsheet_id" text,
  "sheet_tab_name" text NOT NULL DEFAULT 'Books',
  "default_visibility" text NOT NULL DEFAULT 'private',
  "allow_incoming_transfers" integer NOT NULL DEFAULT 0,
  "google_refresh_token_encrypted" text,
  "updated_at" text NOT NULL
);
