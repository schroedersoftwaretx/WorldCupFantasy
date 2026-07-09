-- Phase-05 subset: the survivor pool side-game, gated by the `survivor`
-- feature flag. resolved_outcome written once per pick keeps cron
-- resolution idempotent. Idempotent DDL in the 0006-0017 style.
CREATE TABLE IF NOT EXISTS "survivor_entry" (
  "id"                  serial PRIMARY KEY NOT NULL,
  "league_id"           integer NOT NULL,
  "manager_id"          integer NOT NULL,
  "lives_remaining"     integer DEFAULT 1 NOT NULL,
  "eliminated_at_stage" "stage",
  "created_at"          timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "survivor_entry" ADD CONSTRAINT "survivor_entry_league_id_league_id_fk"
    FOREIGN KEY ("league_id") REFERENCES "public"."league"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "survivor_entry" ADD CONSTRAINT "survivor_entry_manager_id_manager_id_fk"
    FOREIGN KEY ("manager_id") REFERENCES "public"."manager"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "survivor_entry_league_id_manager_id_uq"
  ON "survivor_entry" ("league_id", "manager_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "survivor_entry_league_id_idx"
  ON "survivor_entry" ("league_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "survivor_pick" (
  "survivor_entry_id" integer NOT NULL,
  "stage"             "stage" NOT NULL,
  "national_team_id"  integer,
  "resolved_outcome"  text,
  "created_at"        timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"        timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "survivor_pick_survivor_entry_id_stage_pk"
    PRIMARY KEY ("survivor_entry_id", "stage")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "survivor_pick" ADD CONSTRAINT "survivor_pick_survivor_entry_id_survivor_entry_id_fk"
    FOREIGN KEY ("survivor_entry_id") REFERENCES "public"."survivor_entry"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "survivor_pick" ADD CONSTRAINT "survivor_pick_national_team_id_national_team_id_fk"
    FOREIGN KEY ("national_team_id") REFERENCES "public"."national_team"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
