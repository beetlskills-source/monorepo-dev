-- Phase 6: decouple sheet-level visibility from the new-book default.
--
-- `default_visibility` (the "Default visibility for new books" setting) must
-- only decide the starting `visibility` of a newly scanned book. Whether the
-- user's *whole Google Sheet* appears on other group members' dashboards is a
-- separate concern, so it moves to its own `sheet_visibility` column.
--
-- Backfill preserves the current effective state exactly: a shelf that was
-- already being shown (its owner had `default_visibility = 'shared'`) stays
-- `shared`; every other shelf becomes explicitly `private`. After this, the two
-- settings are independent and predictable.

ALTER TABLE "shelf_configs" ADD COLUMN "sheet_visibility" text NOT NULL DEFAULT 'private';

UPDATE "shelf_configs" SET "sheet_visibility" = 'shared' WHERE "default_visibility" = 'shared';
