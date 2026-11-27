-- User-controlled LLM enrichment preference.
--
-- The ISBN Scanner lets a user decide whether a lookup should also run the
-- (slow, best-effort) Featherless AI enrichment step or stop at the fast
-- catalog result. The choice is a per-user setting, so it lives on the
-- one-row-per-user `shelf_configs` table alongside the other preferences.
--
-- Stored as an integer 0/1 (matching `allow_incoming_transfers`) and defaulting
-- to 0 ("No"): enrichment is opt-in, so an unset preference never waits on the
-- LLM.

ALTER TABLE "shelf_configs" ADD COLUMN "enrich_with_llm" integer NOT NULL DEFAULT 0;
