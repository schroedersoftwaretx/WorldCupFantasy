/**
 * World Cup Fantasy - odds / projections domain tables.
 *
 * Phase 6 (projections): match_odds, projected_score_entry, stage_odds.
 */

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { fixture, nationalTeam, player } from "./football.js";

// --- match_odds -------------------------------------------------------------

/**
 * Fetched-from-The-Odds-API probabilities for a single upcoming fixture.
 * Disposable: recomputable by re-fetching odds. One row per fixture.
 */
export const matchOdds = pgTable(
  "match_odds",
  {
    fixtureId: integer("fixture_id")
      .primaryKey()
      .references(() => fixture.id, { onDelete: "restrict" }),
    /** Implied probability home team wins (0-1). */
    homeWinP: real("home_win_p").notNull(),
    /** Implied probability draw (0-1). */
    drawP: real("draw_p").notNull(),
    /** Implied probability away team wins (0-1). */
    awayWinP: real("away_win_p").notNull(),
    /** Market-implied expected total goals for the match. */
    expectedTotalGoals: real("expected_total_goals").notNull(),
    /** Implied probability home team keeps a clean sheet (0-1). */
    homeCleanSheetP: real("home_clean_sheet_p").notNull(),
    /** Implied probability away team keeps a clean sheet (0-1). */
    awayCleanSheetP: real("away_clean_sheet_p").notNull(),
    /** When these odds were last fetched from the provider. */
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
);

// --- projected_score_entry --------------------------------------------------

/**
 * DERIVED per-player, per-fixture PROJECTED points for SCHEDULED fixtures.
 * Disposable; recomputable from match_odds + stat_line shares + ruleset.
 * Mirrors score_entry but for games not yet played.
 */
export const projectedScoreEntry = pgTable(
  "projected_score_entry",
  {
    playerId: integer("player_id")
      .notNull()
      .references(() => player.id, { onDelete: "restrict" }),
    fixtureId: integer("fixture_id")
      .notNull()
      .references(() => fixture.id, { onDelete: "restrict" }),
    rulesetVersion: text("ruleset_version").notNull(),
    projectedPoints: real("projected_points").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.playerId, t.fixtureId, t.rulesetVersion],
    }),
    playerIdx: index("projected_score_entry_player_id_idx").on(t.playerId),
  }),
);

// --- stage_odds -------------------------------------------------------------

/**
 * Market-implied probability that a national team REACHES a given tournament
 * stage (or wins it outright for CHAMPION). Sourced from The Odds API
 * "to-reach-stage" / outright winner markets, de-vigged so the field sums to
 * the number of slots at that stage. One row per (team, stage).
 *
 * `stage` is one of: "R16" | "QF" | "SF" | "FINAL" | "CHAMPION". It is stored
 * as free text (not the fixture `stage` enum) because these are aggregate
 * "reach" outcomes, not individual fixtures, and CHAMPION has no fixture stage.
 */
export const stageOdds = pgTable(
  "stage_odds",
  {
    nationalTeamId: integer("national_team_id")
      .notNull()
      .references(() => nationalTeam.id, { onDelete: "restrict" }),
    /** "R16" | "QF" | "SF" | "FINAL" | "CHAMPION". */
    stage: text("stage").notNull(),
    /** Implied probability (0-1) of reaching this stage (winning, for CHAMPION). */
    reachP: real("reach_p").notNull(),
    /** When these odds were last fetched from the provider. */
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.nationalTeamId, t.stage] }),
    teamIdx: index("stage_odds_national_team_id_idx").on(t.nationalTeamId),
  }),
);

/** The reach-stage keys we track, latest-first for display ordering. */
export const STAGE_ODDS_STAGES = ["CHAMPION", "FINAL", "SF", "QF", "R16"] as const;
export type StageOddsStage = (typeof STAGE_ODDS_STAGES)[number];

// --- Type helpers ------------------------------------------------------------

export type MatchOddsRow = typeof matchOdds.$inferSelect;
export type MatchOddsInsert = typeof matchOdds.$inferInsert;
export type ProjectedScoreEntryRow = typeof projectedScoreEntry.$inferSelect;
export type ProjectedScoreEntryInsert = typeof projectedScoreEntry.$inferInsert;
export type StageOddsRow = typeof stageOdds.$inferSelect;
export type StageOddsInsert = typeof stageOdds.$inferInsert;
