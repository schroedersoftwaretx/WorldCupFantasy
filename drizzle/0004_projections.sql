-- Phase 6: match odds + projected score entries
-- match_odds: one row per upcoming fixture, holds bookmaker-derived probabilities.
-- projected_score_entry: one row per (player, fixture, ruleset), projected fantasy points.

CREATE TABLE IF NOT EXISTS "match_odds" (
  "fixture_id"           integer PRIMARY KEY NOT NULL,
  "home_win_p"           real NOT NULL,
  "draw_p"               real NOT NULL,
  "away_win_p"           real NOT NULL,
  "expected_total_goals" real NOT NULL,
  "home_clean_sheet_p"   real NOT NULL,
  "away_clean_sheet_p"   real NOT NULL,
  "fetched_at"           timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "match_odds"
    ADD CONSTRAINT "match_odds_fixture_id_fixture_id_fk"
    FOREIGN KEY ("fixture_id") REFERENCES "public"."fixture"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "projected_score_entry" (
  "player_id"         integer NOT NULL,
  "fixture_id"        integer NOT NULL,
  "ruleset_version"   text NOT NULL,
  "projected_points"  real NOT NULL,
  "computed_at"       timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "projected_score_entry_player_id_fixture_id_ruleset_version_pk"
    PRIMARY KEY("player_id","fixture_id","ruleset_version")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "projected_score_entry"
    ADD CONSTRAINT "projected_score_entry_player_id_player_id_fk"
    FOREIGN KEY ("player_id") REFERENCES "public"."player"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "projected_score_entry"
    ADD CONSTRAINT "projected_score_entry_fixture_id_fixture_id_fk"
    FOREIGN KEY ("fixture_id") REFERENCES "public"."fixture"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "projected_score_entry_player_id_idx"
  ON "projected_score_entry" USING btree ("player_id");
