CREATE TABLE IF NOT EXISTS "score_entry" (
	"player_id" integer NOT NULL,
	"fixture_id" integer NOT NULL,
	"ruleset_version" text NOT NULL,
	"points" integer NOT NULL,
	"breakdown" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "score_entry_player_id_fixture_id_ruleset_version_pk" PRIMARY KEY("player_id","fixture_id","ruleset_version")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "score_entry" ADD CONSTRAINT "score_entry_player_id_player_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."player"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "score_entry" ADD CONSTRAINT "score_entry_fixture_id_fixture_id_fk" FOREIGN KEY ("fixture_id") REFERENCES "public"."fixture"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "score_entry_fixture_id_idx" ON "score_entry" USING btree ("fixture_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "score_entry_ruleset_version_idx" ON "score_entry" USING btree ("ruleset_version");
