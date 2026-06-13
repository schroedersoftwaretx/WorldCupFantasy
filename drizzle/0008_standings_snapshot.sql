-- Standings snapshots: one row per (league, stage, fantasy team) recording
-- the team's CUMULATIVE rank and total through the end of that scoring
-- period. Written by the score-recompute paths so the standings page can
-- show rank movement (and "Manager of the Stage") between stages.

CREATE TABLE IF NOT EXISTS "standings_snapshot" (
  "league_id"        integer NOT NULL,
  "stage"            "stage" NOT NULL,
  "fantasy_team_id"  integer NOT NULL,
  "rank"             integer NOT NULL,
  "total"            real NOT NULL,
  "computed_at"      timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "standings_snapshot_league_id_stage_fantasy_team_id_pk"
    PRIMARY KEY("league_id","stage","fantasy_team_id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "standings_snapshot"
    ADD CONSTRAINT "standings_snapshot_league_id_league_id_fk"
    FOREIGN KEY ("league_id") REFERENCES "public"."league"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "standings_snapshot"
    ADD CONSTRAINT "standings_snapshot_fantasy_team_id_fantasy_team_id_fk"
    FOREIGN KEY ("fantasy_team_id") REFERENCES "public"."fantasy_team"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "standings_snapshot_league_id_idx"
  ON "standings_snapshot" USING btree ("league_id");
