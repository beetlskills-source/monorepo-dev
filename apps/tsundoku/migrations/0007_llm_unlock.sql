-- Phase 9: one-time $0.99 "LLM unlock" entitlement. Distinct from the
-- `enrich_with_llm` *preference* (migration 0006): the preference says whether
-- an unlocked user wants enrichment, while this flag records whether the user
-- has paid for the AI features at all (LLM summaries + vision cover reading).
-- Defaults to 0 (locked), so every existing and new user starts on the free
-- tier until the $0.99 unlock is granted.

ALTER TABLE "shelf_configs" ADD COLUMN "has_llm_unlock" integer NOT NULL DEFAULT 0;
