/**
 * World Cup Fantasy - in-season transactions domain (Priority 5).
 *
 * Free agency + waivers + trades, gated by the `transactions` feature flag.
 * A league without the flag never reads or writes these tables.
 *
 * DESIGN. roster_slot remains the CURRENT roster (transactions mutate it in
 * place); roster_transaction is an APPEND-ONLY ledger of every executed
 * movement. Historical per-period rosters are reconstructed by rolling the
 * ledger BACK from the current roster (src/data/transactions/effective-roster
 * .ts), so scoring needs no schema change to roster_slot.
 *
 * EFFECTIVITY. Each ledger row is stamped with `effective_ordinal`: the first
 * scoring period whose first kickoff was still in the future when the
 * movement executed. The player scores for the new team from that period on;
 * earlier periods still credit the old team. Stamping at write time keeps the
 * ledger deterministic even if fixtures shift later.
 *
 * Statuses/kinds are text (activity_event precedent), typed in the service:
 *   roster_transaction.kind: ADD | DROP | TRADE
 *   waiver_claim.status:     PENDING | AWARDED | LOST | INVALID | CANCELLED
 *   trade.status:            PROPOSED | ACCEPTED | REJECTED | CANCELLED | VETOED
 */

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { fantasyTeam, league } from "./leagues.js";
import { player } from "./football.js";

// --- roster_transaction (append-only ledger) ---------------------------------

export const rosterTransaction = pgTable(
  "roster_transaction",
  {
    id: serial("id").primaryKey(),
    leagueId: integer("league_id")
      .notNull()
      .references(() => league.id, { onDelete: "restrict" }),
    /** ADD | DROP | TRADE. */
    kind: text("kind").notNull(),
    playerId: integer("player_id")
      .notNull()
      .references(() => player.id, { onDelete: "restrict" }),
    /** Team the player left; null for a free-agent ADD. */
    fromFantasyTeamId: integer("from_fantasy_team_id").references(
      () => fantasyTeam.id,
      { onDelete: "restrict" },
    ),
    /** Team the player joined; null for a DROP. */
    toFantasyTeamId: integer("to_fantasy_team_id").references(
      () => fantasyTeam.id,
      { onDelete: "restrict" },
    ),
    /** First period ordinal the movement scores in (see header). */
    effectiveOrdinal: integer("effective_ordinal").notNull(),
    /** Provenance when the movement came from a waiver award / trade. */
    waiverClaimId: integer("waiver_claim_id"),
    tradeId: integer("trade_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    leagueCreatedIdx: index("roster_transaction_league_id_created_at_idx").on(
      t.leagueId,
      t.createdAt,
    ),
    leaguePlayerIdx: index("roster_transaction_league_id_player_id_idx").on(
      t.leagueId,
      t.playerId,
    ),
  }),
);

// --- player_waiver (a dropped player's claim window) --------------------------

/**
 * While `until_utc` is in the future the player cannot be added directly -
 * only claimed. Upserted on every drop; stale rows are simply expired
 * (until_utc in the past) and ignored.
 */
export const playerWaiver = pgTable(
  "player_waiver",
  {
    leagueId: integer("league_id")
      .notNull()
      .references(() => league.id, { onDelete: "restrict" }),
    playerId: integer("player_id")
      .notNull()
      .references(() => player.id, { onDelete: "restrict" }),
    untilUtc: timestamp("until_utc", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.leagueId, t.playerId] }),
  }),
);

// --- waiver_claim -------------------------------------------------------------

export const waiverClaim = pgTable(
  "waiver_claim",
  {
    id: serial("id").primaryKey(),
    leagueId: integer("league_id")
      .notNull()
      .references(() => league.id, { onDelete: "restrict" }),
    fantasyTeamId: integer("fantasy_team_id")
      .notNull()
      .references(() => fantasyTeam.id, { onDelete: "restrict" }),
    addPlayerId: integer("add_player_id")
      .notNull()
      .references(() => player.id, { onDelete: "restrict" }),
    /** Player released if the claim is awarded (required when roster full). */
    dropPlayerId: integer("drop_player_id").references(() => player.id, {
      onDelete: "restrict",
    }),
    /** PENDING | AWARDED | LOST | INVALID | CANCELLED. */
    status: text("status").notNull().default("PENDING"),
    /** The cron may process the claim at/after this instant (waiver expiry). */
    processAfter: timestamp("process_after", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** Human-readable resolution note ("lost to <team>", validation error). */
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    leagueStatusIdx: index("waiver_claim_league_id_status_idx").on(
      t.leagueId,
      t.status,
    ),
  }),
);

// --- trade + trade_item --------------------------------------------------------

export const trade = pgTable(
  "trade",
  {
    id: serial("id").primaryKey(),
    leagueId: integer("league_id")
      .notNull()
      .references(() => league.id, { onDelete: "restrict" }),
    proposerTeamId: integer("proposer_team_id")
      .notNull()
      .references(() => fantasyTeam.id, { onDelete: "restrict" }),
    counterpartyTeamId: integer("counterparty_team_id")
      .notNull()
      .references(() => fantasyTeam.id, { onDelete: "restrict" }),
    /** PROPOSED | ACCEPTED | REJECTED | CANCELLED | VETOED. */
    status: text("status").notNull().default("PROPOSED"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => ({
    leagueStatusIdx: index("trade_league_id_status_idx").on(
      t.leagueId,
      t.status,
    ),
  }),
);

/** One player moving one direction inside a trade. */
export const tradeItem = pgTable(
  "trade_item",
  {
    tradeId: integer("trade_id")
      .notNull()
      .references(() => trade.id, { onDelete: "restrict" }),
    playerId: integer("player_id")
      .notNull()
      .references(() => player.id, { onDelete: "restrict" }),
    fromTeamId: integer("from_team_id")
      .notNull()
      .references(() => fantasyTeam.id, { onDelete: "restrict" }),
    toTeamId: integer("to_team_id")
      .notNull()
      .references(() => fantasyTeam.id, { onDelete: "restrict" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tradeId, t.playerId] }),
  }),
);

// --- Type helpers --------------------------------------------------------------

export type RosterTransactionRow = typeof rosterTransaction.$inferSelect;
export type RosterTransactionInsert = typeof rosterTransaction.$inferInsert;
export type PlayerWaiverRow = typeof playerWaiver.$inferSelect;
export type WaiverClaimRow = typeof waiverClaim.$inferSelect;
export type TradeRow = typeof trade.$inferSelect;
export type TradeItemRow = typeof tradeItem.$inferSelect;
