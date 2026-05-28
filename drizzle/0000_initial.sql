CREATE TYPE "public"."fixture_status" AS ENUM('SCHEDULED', 'LIVE', 'FINISHED');--> statement-breakpoint
CREATE TYPE "public"."player_status" AS ENUM('ACTIVE', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."position" AS ENUM('GK', 'DEF', 'MID', 'FWD');--> statement-breakpoint
CREATE TYPE "public"."stage" AS ENUM('GROUP_1', 'GROUP_2', 'GROUP_3', 'R32', 'R16', 'QF', 'SF', 'THIRD_PLACE', 'FINAL');--> statement-breakpoint
CREATE TYPE "public"."team_status" AS ENUM('ACTIVE', 'ELIMINATED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "national_team" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"source_team_id" text NOT NULL,
	"group_label" text,
	"status" "team_status" DEFAULT 'ACTIVE' NOT NULL,
	"eliminated_at_stage" "stage",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "player" (
	"id" serial PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"position" "position" NOT NULL,
	"national_team_id" integer NOT NULL,
	"source_player_id" text NOT NULL,
	"status" "player_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fixture" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_fixture_id" text NOT NULL,
	"stage" "stage" NOT NULL,
	"home_team_id" integer NOT NULL,
	"away_team_id" integer NOT NULL,
	"kickoff_utc" timestamp with time zone NOT NULL,
	"status" "fixture_status" DEFAULT 'SCHEDULED' NOT NULL,
	"home_score" integer,
	"away_score" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stat_line" (
	"player_id" integer NOT NULL,
	"fixture_id" integer NOT NULL,
	"minutes_played" integer DEFAULT 0 NOT NULL,
	"goals" integer DEFAULT 0 NOT NULL,
	"assists" integer DEFAULT 0 NOT NULL,
	"saves" integer DEFAULT 0 NOT NULL,
	"yellow_cards" integer DEFAULT 0 NOT NULL,
	"red_cards" integer DEFAULT 0 NOT NULL,
	"penalties_scored" integer DEFAULT 0 NOT NULL,
	"penalties_missed" integer DEFAULT 0 NOT NULL,
	"penalties_saved" integer DEFAULT 0 NOT NULL,
	"own_goals" integer DEFAULT 0 NOT NULL,
	"team_conceded_in_regulation_and_et" integer DEFAULT 0 NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_revision" text NOT NULL,
	CONSTRAINT "stat_line_player_id_fixture_id_pk" PRIMARY KEY("player_id","fixture_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "player" ADD CONSTRAINT "player_national_team_id_national_team_id_fk" FOREIGN KEY ("national_team_id") REFERENCES "public"."national_team"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fixture" ADD CONSTRAINT "fixture_home_team_id_national_team_id_fk" FOREIGN KEY ("home_team_id") REFERENCES "public"."national_team"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fixture" ADD CONSTRAINT "fixture_away_team_id_national_team_id_fk" FOREIGN KEY ("away_team_id") REFERENCES "public"."national_team"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stat_line" ADD CONSTRAINT "stat_line_player_id_player_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."player"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stat_line" ADD CONSTRAINT "stat_line_fixture_id_fixture_id_fk" FOREIGN KEY ("fixture_id") REFERENCES "public"."fixture"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "national_team_source_team_id_uq" ON "national_team" USING btree ("source_team_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "player_source_player_id_uq" ON "player" USING btree ("source_player_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fixture_source_fixture_id_uq" ON "fixture" USING btree ("source_fixture_id");
