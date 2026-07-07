-- Phase 3 subset 3.2/3.3: append-only league activity feed + stage recaps.
-- STAGE_RECAP rows are unique per (league, stage) so recap generation is
-- idempotent when the cron reruns. Idempotent DDL in the 0006-0016 style.
CREATE TABLE IF NOT EXISTS "activity_event" (
  "id"         serial PRIMARY KEY NOT NULL,
  "league_id"  integer NOT NULL,
  "type"       text NOT NULL,
  "payload"    jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "activity_event" ADD CONSTRAINT "activity_event_league_id_league_id_fk"
    FOREIGN KEY ("league_id") REFERENCES "public"."league"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_event_league_id_created_at_idx"
  ON "activity_event" ("league_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "activity_event_stage_recap_uq"
  ON "activity_event" ("league_id", ("payload"->>'stage'))
  WHERE "type" = 'STAGE_RECAP';
