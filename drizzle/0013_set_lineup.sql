-- Phase 9 Priority 1: the SET_LINEUP format. One submitted starting XI per
-- (fantasy team, scoring period) with captain / vice-captain. Additive and
-- flag-gated: only leagues with format = 'SET_LINEUP' touch this table, so
-- best-ball leagues are unaffected. Idempotent in the 0006-0012 style.
CREATE TABLE IF NOT EXISTS "lineup" (
  "fantasy_team_id"        integer NOT NULL,
  "scoring_period_id"      integer NOT NULL,
  "player_ids"             jsonb NOT NULL,
  "captain_player_id"      integer NOT NULL,
  "vice_captain_player_id" integer,
  "created_at"             timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"             timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "lineup_fantasy_team_id_scoring_period_id_pk"
    PRIMARY KEY ("fantasy_team_id", "scoring_period_id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "lineup" ADD CONSTRAINT "lineup_fantasy_team_id_fantasy_team_id_fk"
    FOREIGN KEY ("fantasy_team_id") REFERENCES "public"."fantasy_team"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "lineup" ADD CONSTRAINT "lineup_scoring_period_id_scoring_period_id_fk"
    FOREIGN KEY ("scoring_period_id") REFERENCES "public"."scoring_period"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "lineup" ADD CONSTRAINT "lineup_captain_player_id_player_id_fk"
    FOREIGN KEY ("captain_player_id") REFERENCES "public"."player"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "lineup" ADD CONSTRAINT "lineup_vice_captain_player_id_player_id_fk"
    FOREIGN KEY ("vice_captain_player_id") REFERENCES "public"."player"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lineup_scoring_period_id_idx"
  ON "lineup" ("scoring_period_id");
