-- Stage odds: market-implied probability a national team REACHES a given
-- tournament stage (or wins it, for CHAMPION). Sourced from The Odds API
-- "to-reach-stage" / outright winner markets. One row per (team, stage).

CREATE TABLE IF NOT EXISTS "stage_odds" (
  "national_team_id" integer NOT NULL,
  "stage"            text NOT NULL,
  "reach_p"          real NOT NULL,
  "fetched_at"       timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "stage_odds_national_team_id_stage_pk"
    PRIMARY KEY("national_team_id","stage")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "stage_odds"
    ADD CONSTRAINT "stage_odds_national_team_id_national_team_id_fk"
    FOREIGN KEY ("national_team_id") REFERENCES "public"."national_team"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stage_odds_national_team_id_idx"
  ON "stage_odds" USING btree ("national_team_id");
