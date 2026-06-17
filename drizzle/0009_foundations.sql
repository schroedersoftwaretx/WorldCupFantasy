-- Phase 0 foundations: the app-wide notification hub and per-league feature
-- flags. Append-only and idempotent (CREATE ... IF NOT EXISTS + guarded
-- CREATE TYPE / ADD CONSTRAINT) so a re-run is safe, matching 0006-0008.

-- New enums for the generalized notification table. Guarded because
-- CREATE TYPE has no IF NOT EXISTS.
DO $$ BEGIN
  CREATE TYPE "public"."notification_channel" AS ENUM('IN_APP', 'EMAIL');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."app_notification_status" AS ENUM('PENDING', 'SENT', 'FAILED', 'READ');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification" (
  "id"          serial PRIMARY KEY NOT NULL,
  "manager_id"  integer NOT NULL,
  "league_id"   integer,
  "type"        text NOT NULL,
  "channel"     "notification_channel" NOT NULL,
  "status"      "app_notification_status" DEFAULT 'PENDING' NOT NULL,
  "title"       text NOT NULL,
  "body"        text NOT NULL,
  "link"        text,
  "dedupe_key"  text,
  "created_at"  timestamp with time zone DEFAULT now() NOT NULL,
  "sent_at"     timestamp with time zone,
  "read_at"     timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "league_feature_flag" (
  "league_id"  integer NOT NULL,
  "flag"       text NOT NULL,
  "enabled"    boolean DEFAULT false NOT NULL,
  "config"     jsonb,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "league_feature_flag_league_id_flag_pk" PRIMARY KEY("league_id","flag")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "notification"
    ADD CONSTRAINT "notification_manager_id_manager_id_fk"
    FOREIGN KEY ("manager_id") REFERENCES "public"."manager"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "notification"
    ADD CONSTRAINT "notification_league_id_league_id_fk"
    FOREIGN KEY ("league_id") REFERENCES "public"."league"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "league_feature_flag"
    ADD CONSTRAINT "league_feature_flag_league_id_league_id_fk"
    FOREIGN KEY ("league_id") REFERENCES "public"."league"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_manager_id_idx" ON "notification" USING btree ("manager_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_status_idx" ON "notification" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_manager_channel_dedupe_uq" ON "notification" USING btree ("manager_id","channel","dedupe_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "league_feature_flag_league_id_idx" ON "league_feature_flag" USING btree ("league_id");
