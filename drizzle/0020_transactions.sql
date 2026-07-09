-- Priority 5: in-season transactions (free agency + waivers + trades), gated
-- by the `transactions` feature flag. roster_slot stays the current roster;
-- roster_transaction is the append-only movement ledger used to reconstruct
-- per-period rosters at scoring time. Idempotent DDL in the 0006-0019 style.
CREATE TABLE IF NOT EXISTS "roster_transaction" (
  "id"                   serial PRIMARY KEY NOT NULL,
  "league_id"            integer NOT NULL,
  "kind"                 text NOT NULL,
  "player_id"            integer NOT NULL,
  "from_fantasy_team_id" integer,
  "to_fantasy_team_id"   integer,
  "effective_ordinal"    integer NOT NULL,
  "waiver_claim_id"      integer,
  "trade_id"             integer,
  "created_at"           timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "roster_transaction" ADD CONSTRAINT "roster_transaction_league_id_league_id_fk"
    FOREIGN KEY ("league_id") REFERENCES "public"."league"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "roster_transaction" ADD CONSTRAINT "roster_transaction_player_id_player_id_fk"
    FOREIGN KEY ("player_id") REFERENCES "public"."player"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "roster_transaction" ADD CONSTRAINT "roster_transaction_from_fantasy_team_id_fantasy_team_id_fk"
    FOREIGN KEY ("from_fantasy_team_id") REFERENCES "public"."fantasy_team"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "roster_transaction" ADD CONSTRAINT "roster_transaction_to_fantasy_team_id_fantasy_team_id_fk"
    FOREIGN KEY ("to_fantasy_team_id") REFERENCES "public"."fantasy_team"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "roster_transaction_league_id_created_at_idx"
  ON "roster_transaction" ("league_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "roster_transaction_league_id_player_id_idx"
  ON "roster_transaction" ("league_id", "player_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "player_waiver" (
  "league_id"  integer NOT NULL,
  "player_id"  integer NOT NULL,
  "until_utc"  timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "player_waiver_league_id_player_id_pk"
    PRIMARY KEY ("league_id", "player_id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "player_waiver" ADD CONSTRAINT "player_waiver_league_id_league_id_fk"
    FOREIGN KEY ("league_id") REFERENCES "public"."league"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "player_waiver" ADD CONSTRAINT "player_waiver_player_id_player_id_fk"
    FOREIGN KEY ("player_id") REFERENCES "public"."player"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "waiver_claim" (
  "id"              serial PRIMARY KEY NOT NULL,
  "league_id"       integer NOT NULL,
  "fantasy_team_id" integer NOT NULL,
  "add_player_id"   integer NOT NULL,
  "drop_player_id"  integer,
  "status"          text DEFAULT 'PENDING' NOT NULL,
  "process_after"   timestamp with time zone NOT NULL,
  "resolved_at"     timestamp with time zone,
  "note"            text,
  "created_at"      timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "waiver_claim" ADD CONSTRAINT "waiver_claim_league_id_league_id_fk"
    FOREIGN KEY ("league_id") REFERENCES "public"."league"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "waiver_claim" ADD CONSTRAINT "waiver_claim_fantasy_team_id_fantasy_team_id_fk"
    FOREIGN KEY ("fantasy_team_id") REFERENCES "public"."fantasy_team"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "waiver_claim" ADD CONSTRAINT "waiver_claim_add_player_id_player_id_fk"
    FOREIGN KEY ("add_player_id") REFERENCES "public"."player"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "waiver_claim" ADD CONSTRAINT "waiver_claim_drop_player_id_player_id_fk"
    FOREIGN KEY ("drop_player_id") REFERENCES "public"."player"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "waiver_claim_league_id_status_idx"
  ON "waiver_claim" ("league_id", "status");
--> statement-breakpoint
-- One live claim per (team, target player): duplicates are a UX footgun and
-- would make cron awards ambiguous. Partial index (raw SQL, 0017 style).
CREATE UNIQUE INDEX IF NOT EXISTS "waiver_claim_pending_team_add_uq"
  ON "waiver_claim" ("fantasy_team_id", "add_player_id")
  WHERE "status" = 'PENDING';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trade" (
  "id"                   serial PRIMARY KEY NOT NULL,
  "league_id"            integer NOT NULL,
  "proposer_team_id"     integer NOT NULL,
  "counterparty_team_id" integer NOT NULL,
  "status"               text DEFAULT 'PROPOSED' NOT NULL,
  "created_at"           timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at"          timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "trade" ADD CONSTRAINT "trade_league_id_league_id_fk"
    FOREIGN KEY ("league_id") REFERENCES "public"."league"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "trade" ADD CONSTRAINT "trade_proposer_team_id_fantasy_team_id_fk"
    FOREIGN KEY ("proposer_team_id") REFERENCES "public"."fantasy_team"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "trade" ADD CONSTRAINT "trade_counterparty_team_id_fantasy_team_id_fk"
    FOREIGN KEY ("counterparty_team_id") REFERENCES "public"."fantasy_team"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trade_league_id_status_idx"
  ON "trade" ("league_id", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trade_item" (
  "trade_id"     integer NOT NULL,
  "player_id"    integer NOT NULL,
  "from_team_id" integer NOT NULL,
  "to_team_id"   integer NOT NULL,
  CONSTRAINT "trade_item_trade_id_player_id_pk"
    PRIMARY KEY ("trade_id", "player_id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "trade_item" ADD CONSTRAINT "trade_item_trade_id_trade_id_fk"
    FOREIGN KEY ("trade_id") REFERENCES "public"."trade"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "trade_item" ADD CONSTRAINT "trade_item_player_id_player_id_fk"
    FOREIGN KEY ("player_id") REFERENCES "public"."player"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "trade_item" ADD CONSTRAINT "trade_item_from_team_id_fantasy_team_id_fk"
    FOREIGN KEY ("from_team_id") REFERENCES "public"."fantasy_team"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "trade_item" ADD CONSTRAINT "trade_item_to_team_id_fantasy_team_id_fk"
    FOREIGN KEY ("to_team_id") REFERENCES "public"."fantasy_team"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
