-- Phase 9 foundation: multi-competition. Adds competition + scoring_period so
-- "what are the scoring periods" is data, not the hardcoded stage enum, then
-- backfills the current World Cup so existing best-ball leagues compute
-- byte-identical standings. Append-only and idempotent (CREATE ... IF NOT
-- EXISTS + guarded CREATE TYPE + WHERE NOT EXISTS seeds), matching 0006-0011.
-- The stage enum and fixture.stage column stay in place (WC tie-breakers and
-- standings_snapshot still reference them); scoring_period_id is additive.

DO $$ BEGIN
  CREATE TYPE "public"."competition_kind" AS ENUM('WORLD_CUP', 'LEAGUE', 'CONTINENTAL_CUP');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."league_format" AS ENUM('BEST_BALL', 'SET_LINEUP', 'HEAD_TO_HEAD');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "competition" (
  "id"           serial PRIMARY KEY NOT NULL,
  "name"         text NOT NULL,
  "kind"         "competition_kind" NOT NULL,
  "season_label" text NOT NULL,
  "created_at"   timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"   timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "competition_name_season_label_uq"
  ON "competition" ("name", "season_label");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scoring_period" (
  "id"             serial PRIMARY KEY NOT NULL,
  "competition_id" integer NOT NULL,
  "ordinal"        integer NOT NULL,
  "label"          text NOT NULL,
  "stage_code"     "stage",
  "starts_at"      timestamp with time zone,
  "ends_at"        timestamp with time zone,
  "created_at"     timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "scoring_period" ADD CONSTRAINT "scoring_period_competition_id_competition_id_fk"
    FOREIGN KEY ("competition_id") REFERENCES "public"."competition"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scoring_period_competition_id_ordinal_uq"
  ON "scoring_period" ("competition_id", "ordinal");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scoring_period_competition_id_idx"
  ON "scoring_period" ("competition_id");
--> statement-breakpoint
ALTER TABLE "league" ADD COLUMN IF NOT EXISTS "competition_id" integer;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "league" ADD CONSTRAINT "league_competition_id_competition_id_fk"
    FOREIGN KEY ("competition_id") REFERENCES "public"."competition"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "league" ADD COLUMN IF NOT EXISTS "format" "league_format" DEFAULT 'BEST_BALL' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fixture" ADD COLUMN IF NOT EXISTS "scoring_period_id" integer;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "fixture" ADD CONSTRAINT "fixture_scoring_period_id_scoring_period_id_fk"
    FOREIGN KEY ("scoring_period_id") REFERENCES "public"."scoring_period"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Backfill (PLAN 3.2): seed the current World Cup and its nine stage periods,
-- then point existing leagues and fixtures at them. Each statement is a no-op
-- on re-run (WHERE NOT EXISTS / IS NULL guards).
INSERT INTO "competition" ("name", "kind", "season_label")
SELECT 'FIFA World Cup', 'WORLD_CUP', '2026'
WHERE NOT EXISTS (
  SELECT 1 FROM "competition"
  WHERE "name" = 'FIFA World Cup' AND "season_label" = '2026'
);
--> statement-breakpoint
INSERT INTO "scoring_period" ("competition_id", "ordinal", "label", "stage_code")
SELECT c."id", v."ordinal", v."label", v."code"::"stage"
FROM "competition" c
CROSS JOIN (VALUES
  (1, 'Group 1',        'GROUP_1'),
  (2, 'Group 2',        'GROUP_2'),
  (3, 'Group 3',        'GROUP_3'),
  (4, 'Round of 32',    'R32'),
  (5, 'Round of 16',    'R16'),
  (6, 'Quarter-finals', 'QF'),
  (7, 'Semi-finals',    'SF'),
  (8, 'Third place',    'THIRD_PLACE'),
  (9, 'Final',          'FINAL')
) AS v("ordinal", "label", "code")
WHERE c."name" = 'FIFA World Cup' AND c."season_label" = '2026'
  AND NOT EXISTS (
    SELECT 1 FROM "scoring_period" sp
    WHERE sp."competition_id" = c."id" AND sp."ordinal" = v."ordinal"
  );
--> statement-breakpoint
UPDATE "league" SET "competition_id" = (
  SELECT "id" FROM "competition"
  WHERE "name" = 'FIFA World Cup' AND "season_label" = '2026'
)
WHERE "competition_id" IS NULL;
--> statement-breakpoint
UPDATE "fixture" f SET "scoring_period_id" = sp."id"
FROM "scoring_period" sp
JOIN "competition" c ON c."id" = sp."competition_id"
WHERE c."name" = 'FIFA World Cup' AND c."season_label" = '2026'
  AND f."scoring_period_id" IS NULL
  AND sp."stage_code" = f."stage";
