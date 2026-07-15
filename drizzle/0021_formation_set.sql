-- Formation sets: which preset formation list a league's XIs may use.
-- CLASSIC = the original World Cup four (4-3-3, 4-4-2, 5-2-3, 5-3-2);
-- EXPANDED = the FPL-style eight (adds back-three / lone-striker shapes).
-- Additive + idempotent in the 0006-0020 style. Existing leagues default to
-- CLASSIC, so best-ball scoring and lineup legality are byte-identical.
DO $$ BEGIN
  CREATE TYPE "public"."formation_set" AS ENUM ('CLASSIC', 'EXPANDED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "league"
  ADD COLUMN IF NOT EXISTS "formation_set" "formation_set"
  DEFAULT 'CLASSIC' NOT NULL;
