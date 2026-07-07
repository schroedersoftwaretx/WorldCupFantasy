-- Phase 9 Priority 3: chips + per-period captain (best-ball). A read-time
-- overlay gated by the `chips` feature flag - score_entry is never written.
-- Idempotent in the 0006-0014 style.
DO $$ BEGIN
  CREATE TYPE "public"."chip_type" AS ENUM('TRIPLE_CAPTAIN', 'BENCH_BOOST', 'STAGE_BOOST');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "period_captain" (
  "fantasy_team_id"   integer NOT NULL,
  "scoring_period_id" integer NOT NULL,
  "player_id"         integer NOT NULL,
  "created_at"        timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"        timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "period_captain_fantasy_team_id_scoring_period_id_pk"
    PRIMARY KEY ("fantasy_team_id", "scoring_period_id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "period_captain" ADD CONSTRAINT "period_captain_fantasy_team_id_fantasy_team_id_fk"
    FOREIGN KEY ("fantasy_team_id") REFERENCES "public"."fantasy_team"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "period_captain" ADD CONSTRAINT "period_captain_scoring_period_id_scoring_period_id_fk"
    FOREIGN KEY ("scoring_period_id") REFERENCES "public"."scoring_period"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "period_captain" ADD CONSTRAINT "period_captain_player_id_player_id_fk"
    FOREIGN KEY ("player_id") REFERENCES "public"."player"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chip_play" (
  "id"                serial PRIMARY KEY NOT NULL,
  "league_id"         integer NOT NULL,
  "fantasy_team_id"   integer NOT NULL,
  "chip"              "chip_type" NOT NULL,
  "scoring_period_id" integer NOT NULL,
  "created_at"        timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "chip_play" ADD CONSTRAINT "chip_play_league_id_league_id_fk"
    FOREIGN KEY ("league_id") REFERENCES "public"."league"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "chip_play" ADD CONSTRAINT "chip_play_fantasy_team_id_fantasy_team_id_fk"
    FOREIGN KEY ("fantasy_team_id") REFERENCES "public"."fantasy_team"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "chip_play" ADD CONSTRAINT "chip_play_scoring_period_id_scoring_period_id_fk"
    FOREIGN KEY ("scoring_period_id") REFERENCES "public"."scoring_period"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chip_play_league_team_chip_uq"
  ON "chip_play" ("league_id", "fantasy_team_id", "chip");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chip_play_league_team_period_uq"
  ON "chip_play" ("league_id", "fantasy_team_id", "scoring_period_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chip_play_league_id_idx" ON "chip_play" ("league_id");
