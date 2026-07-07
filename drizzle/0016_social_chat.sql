-- Phase 3 subset (built during Phase 9 Priority 4): per-league chat with
-- reactions, gated by the `chat` feature flag. Soft deletes keep thread
-- shape. Idempotent in the 0006-0015 style.
CREATE TABLE IF NOT EXISTS "chat_message" (
  "id"         serial PRIMARY KEY NOT NULL,
  "league_id"  integer NOT NULL,
  "manager_id" integer NOT NULL,
  "body"       text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "edited_at"  timestamp with time zone,
  "deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_league_id_league_id_fk"
    FOREIGN KEY ("league_id") REFERENCES "public"."league"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_manager_id_manager_id_fk"
    FOREIGN KEY ("manager_id") REFERENCES "public"."manager"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_message_league_id_created_at_idx"
  ON "chat_message" ("league_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_reaction" (
  "message_id" integer NOT NULL,
  "manager_id" integer NOT NULL,
  "emoji"      text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "chat_reaction_message_id_manager_id_emoji_pk"
    PRIMARY KEY ("message_id", "manager_id", "emoji")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "chat_reaction" ADD CONSTRAINT "chat_reaction_message_id_chat_message_id_fk"
    FOREIGN KEY ("message_id") REFERENCES "public"."chat_message"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "chat_reaction" ADD CONSTRAINT "chat_reaction_manager_id_manager_id_fk"
    FOREIGN KEY ("manager_id") REFERENCES "public"."manager"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
