CREATE TYPE "public"."league_status" AS ENUM('SETUP', 'DRAFTING', 'ACTIVE', 'COMPLETE');--> statement-breakpoint
CREATE TYPE "public"."league_role" AS ENUM('OWNER', 'MEMBER');--> statement-breakpoint
CREATE TYPE "public"."invite_status" AS ENUM('PENDING', 'ACCEPTED', 'REVOKED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "manager" (
	"id" serial PRIMARY KEY NOT NULL,
	"firebase_uid" text NOT NULL,
	"display_name" text NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "league" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_by_manager_id" integer NOT NULL,
	"scoring_ruleset" jsonb NOT NULL,
	"max_managers" integer DEFAULT 24 NOT NULL,
	"roster_size" integer DEFAULT 23 NOT NULL,
	"status" "league_status" DEFAULT 'SETUP' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "league_membership" (
	"league_id" integer NOT NULL,
	"manager_id" integer NOT NULL,
	"role" "league_role" DEFAULT 'MEMBER' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "league_membership_league_id_manager_id_pk" PRIMARY KEY("league_id","manager_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "league_invite" (
	"id" serial PRIMARY KEY NOT NULL,
	"league_id" integer NOT NULL,
	"token" text NOT NULL,
	"email" text,
	"status" "invite_status" DEFAULT 'PENDING' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_by_manager_id" integer,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fantasy_team" (
	"id" serial PRIMARY KEY NOT NULL,
	"league_id" integer NOT NULL,
	"manager_id" integer NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "roster_slot" (
	"fantasy_team_id" integer NOT NULL,
	"player_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"drafted_position" "position" NOT NULL,
	"drafted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_slot_fantasy_team_id_player_id_pk" PRIMARY KEY("fantasy_team_id","player_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "league" ADD CONSTRAINT "league_created_by_manager_id_manager_id_fk" FOREIGN KEY ("created_by_manager_id") REFERENCES "public"."manager"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "league_membership" ADD CONSTRAINT "league_membership_league_id_league_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."league"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "league_membership" ADD CONSTRAINT "league_membership_manager_id_manager_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."manager"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "league_invite" ADD CONSTRAINT "league_invite_league_id_league_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."league"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "league_invite" ADD CONSTRAINT "league_invite_accepted_by_manager_id_manager_id_fk" FOREIGN KEY ("accepted_by_manager_id") REFERENCES "public"."manager"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fantasy_team" ADD CONSTRAINT "fantasy_team_league_id_league_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."league"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fantasy_team" ADD CONSTRAINT "fantasy_team_manager_id_manager_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."manager"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "roster_slot" ADD CONSTRAINT "roster_slot_fantasy_team_id_fantasy_team_id_fk" FOREIGN KEY ("fantasy_team_id") REFERENCES "public"."fantasy_team"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "roster_slot" ADD CONSTRAINT "roster_slot_player_id_player_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."player"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "roster_slot" ADD CONSTRAINT "roster_slot_league_id_league_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."league"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "manager_firebase_uid_uq" ON "manager" USING btree ("firebase_uid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "league_membership_manager_id_idx" ON "league_membership" USING btree ("manager_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "league_invite_token_uq" ON "league_invite" USING btree ("token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "league_invite_league_id_idx" ON "league_invite" USING btree ("league_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fantasy_team_league_id_manager_id_uq" ON "fantasy_team" USING btree ("league_id","manager_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "roster_slot_league_id_player_id_uq" ON "roster_slot" USING btree ("league_id","player_id");
