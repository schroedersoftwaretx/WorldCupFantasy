-- Phase 9 Priority 2: head-to-head. Stores ONLY the matchup schedule (two
-- fantasy teams per scoring period); results are derived from period totals
-- at read time, never stored. Gated by the head_to_head feature flag, so
-- leagues without it are untouched. Idempotent in the 0006-0013 style.
CREATE TABLE IF NOT EXISTS "matchup" (
  "id"                   serial PRIMARY KEY NOT NULL,
  "league_id"            integer NOT NULL,
  "scoring_period_id"    integer NOT NULL,
  "home_fantasy_team_id" integer NOT NULL,
  "away_fantasy_team_id" integer NOT NULL,
  "created_at"           timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "matchup" ADD CONSTRAINT "matchup_league_id_league_id_fk"
    FOREIGN KEY ("league_id") REFERENCES "public"."league"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "matchup" ADD CONSTRAINT "matchup_scoring_period_id_scoring_period_id_fk"
    FOREIGN KEY ("scoring_period_id") REFERENCES "public"."scoring_period"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "matchup" ADD CONSTRAINT "matchup_home_fantasy_team_id_fantasy_team_id_fk"
    FOREIGN KEY ("home_fantasy_team_id") REFERENCES "public"."fantasy_team"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "matchup" ADD CONSTRAINT "matchup_away_fantasy_team_id_fantasy_team_id_fk"
    FOREIGN KEY ("away_fantasy_team_id") REFERENCES "public"."fantasy_team"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "matchup_league_period_home_uq"
  ON "matchup" ("league_id", "scoring_period_id", "home_fantasy_team_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "matchup_league_period_away_uq"
  ON "matchup" ("league_id", "scoring_period_id", "away_fantasy_team_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "matchup_league_id_idx" ON "matchup" ("league_id");
