-- Phase 8 subset: per-manager notification preferences + draft-room pick queue.
-- Append-only and idempotent (CREATE ... IF NOT EXISTS + guarded ADD CONSTRAINT)
-- so a re-run is safe, matching 0006-0009. Never hand-edit an existing migration.

-- Per-manager, per-category, per-channel notification toggle. A row exists
-- only for a (manager, category, channel) the manager has explicitly set;
-- an absent row falls back to "enabled" (opt-out model). `category` mirrors
-- the free-text notification.type (e.g. ON_THE_CLOCK), `channel` reuses the
-- existing notification_channel enum.
CREATE TABLE IF NOT EXISTS "notification_preference" (
  "manager_id" integer NOT NULL,
  "category"   text NOT NULL,
  "channel"    "notification_channel" NOT NULL,
  "enabled"    boolean DEFAULT true NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "notification_preference_pk" PRIMARY KEY("manager_id","category","channel")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "notification_preference"
    ADD CONSTRAINT "notification_preference_manager_id_manager_id_fk"
    FOREIGN KEY ("manager_id") REFERENCES "public"."manager"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_preference_manager_id_idx" ON "notification_preference" USING btree ("manager_id");
--> statement-breakpoint
-- One manager's ranked targets for one draft room. Lower `rank` = higher
-- priority. Autopick consults this (still-available, position-legal) before
-- falling back to draft_rank. Snake order and timer mechanics are untouched.
CREATE TABLE IF NOT EXISTS "draft_queue" (
  "draft_room_id"  integer NOT NULL,
  "fantasy_team_id" integer NOT NULL,
  "player_id"      integer NOT NULL,
  "rank"           integer NOT NULL,
  "created_at"     timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "draft_queue_pk" PRIMARY KEY("draft_room_id","fantasy_team_id","player_id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "draft_queue"
    ADD CONSTRAINT "draft_queue_draft_room_id_draft_room_id_fk"
    FOREIGN KEY ("draft_room_id") REFERENCES "public"."draft_room"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "draft_queue"
    ADD CONSTRAINT "draft_queue_fantasy_team_id_fantasy_team_id_fk"
    FOREIGN KEY ("fantasy_team_id") REFERENCES "public"."fantasy_team"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "draft_queue"
    ADD CONSTRAINT "draft_queue_player_id_player_id_fk"
    FOREIGN KEY ("player_id") REFERENCES "public"."player"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "draft_queue_room_team_rank_idx" ON "draft_queue" USING btree ("draft_room_id","fantasy_team_id","rank");
