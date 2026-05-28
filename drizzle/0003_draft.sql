CREATE TYPE "public"."draft_status" AS ENUM('PENDING', 'IN_PROGRESS', 'COMPLETE');--> statement-breakpoint
CREATE TYPE "public"."draft_notification_type" AS ENUM('DRAFT_STARTED', 'ON_THE_CLOCK', 'PICK_MADE', 'AUTOPICK_MADE', 'DRAFT_COMPLETE');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('PENDING', 'SENT', 'FAILED');--> statement-breakpoint
ALTER TABLE "player" ADD COLUMN IF NOT EXISTS "draft_rank" integer;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "draft_room" (
	"id" serial PRIMARY KEY NOT NULL,
	"league_id" integer NOT NULL,
	"status" "draft_status" DEFAULT 'PENDING' NOT NULL,
	"pick_timer_hours" integer DEFAULT 12 NOT NULL,
	"total_picks" integer DEFAULT 0 NOT NULL,
	"current_pick_number" integer,
	"current_pick_deadline" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "draft_order" (
	"draft_room_id" integer NOT NULL,
	"slot" integer NOT NULL,
	"fantasy_team_id" integer NOT NULL,
	CONSTRAINT "draft_order_draft_room_id_slot_pk" PRIMARY KEY("draft_room_id","slot")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "draft_pick" (
	"id" serial PRIMARY KEY NOT NULL,
	"draft_room_id" integer NOT NULL,
	"pick_number" integer NOT NULL,
	"round" integer NOT NULL,
	"fantasy_team_id" integer NOT NULL,
	"player_id" integer NOT NULL,
	"is_autopick" boolean DEFAULT false NOT NULL,
	"picked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "draft_notification" (
	"id" serial PRIMARY KEY NOT NULL,
	"draft_room_id" integer NOT NULL,
	"manager_id" integer NOT NULL,
	"fantasy_team_id" integer,
	"type" "draft_notification_type" NOT NULL,
	"status" "notification_status" DEFAULT 'PENDING' NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draft_room" ADD CONSTRAINT "draft_room_league_id_league_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."league"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draft_order" ADD CONSTRAINT "draft_order_draft_room_id_draft_room_id_fk" FOREIGN KEY ("draft_room_id") REFERENCES "public"."draft_room"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draft_order" ADD CONSTRAINT "draft_order_fantasy_team_id_fantasy_team_id_fk" FOREIGN KEY ("fantasy_team_id") REFERENCES "public"."fantasy_team"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draft_pick" ADD CONSTRAINT "draft_pick_draft_room_id_draft_room_id_fk" FOREIGN KEY ("draft_room_id") REFERENCES "public"."draft_room"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draft_pick" ADD CONSTRAINT "draft_pick_fantasy_team_id_fantasy_team_id_fk" FOREIGN KEY ("fantasy_team_id") REFERENCES "public"."fantasy_team"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draft_pick" ADD CONSTRAINT "draft_pick_player_id_player_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."player"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draft_notification" ADD CONSTRAINT "draft_notification_draft_room_id_draft_room_id_fk" FOREIGN KEY ("draft_room_id") REFERENCES "public"."draft_room"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draft_notification" ADD CONSTRAINT "draft_notification_manager_id_manager_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."manager"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draft_notification" ADD CONSTRAINT "draft_notification_fantasy_team_id_fantasy_team_id_fk" FOREIGN KEY ("fantasy_team_id") REFERENCES "public"."fantasy_team"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "draft_room_league_id_uq" ON "draft_room" USING btree ("league_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "draft_order_room_team_uq" ON "draft_order" USING btree ("draft_room_id","fantasy_team_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "draft_pick_room_pick_number_uq" ON "draft_pick" USING btree ("draft_room_id","pick_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "draft_notification_room_id_idx" ON "draft_notification" USING btree ("draft_room_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "draft_notification_status_idx" ON "draft_notification" USING btree ("status");
