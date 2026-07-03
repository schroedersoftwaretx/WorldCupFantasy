/**
 * World Cup Fantasy - football domain tables.
 *
 * Phase 1 (data spine): national_team, player, fixture, stat_line.
 * Phase 2 (scoring):     score_entry.
 *
 * Invariants worth remembering:
 *   - stat_line is the immutable SOURCE OF TRUTH; only the ingestion path
 *     writes it. score_entry is fully recomputable from it.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import {
  fixtureStatusEnum,
  playerStatusEnum,
  positionEnum,
  stageEnum,
  teamStatusEnum,
} from "./enums.js";
import { scoringPeriod } from "./competition.js";

// --- national_team ----------------------------------------------------------

export const nationalTeam = pgTable(
  "national_team",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    sourceTeamId: text("source_team_id").notNull(),
    groupLabel: text("group_label"),
    status: teamStatusEnum("status").notNull().default("ACTIVE"),
    eliminatedAtStage: stageEnum("eliminated_at_stage"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    sourceTeamIdUq: uniqueIndex("national_team_source_team_id_uq").on(t.sourceTeamId),
  }),
);

// --- player -----------------------------------------------------------------

export const player = pgTable(
  "player",
  {
    id: serial("id").primaryKey(),
    fullName: text("full_name").notNull(),
    position: positionEnum("position").notNull(),
    nationalTeamId: integer("national_team_id")
      .notNull()
      .references(() => nationalTeam.id, { onDelete: "restrict" }),
    sourcePlayerId: text("source_player_id").notNull(),
    status: playerStatusEnum("status").notNull().default("ACTIVE"),
    /**
     * Pre-tournament draft ranking (a "big board"): lower = better. NULL
     * when unranked. The constraint-aware autopick prefers the lowest
     * draft_rank among legal candidates; ties + nulls fall back to a
     * deterministic order by player id.
     */
    draftRank: integer("draft_rank"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    sourcePlayerIdUq: uniqueIndex("player_source_player_id_uq").on(t.sourcePlayerId),
  }),
);

// --- fixture ----------------------------------------------------------------

export const fixture = pgTable(
  "fixture",
  {
    id: serial("id").primaryKey(),
    sourceFixtureId: text("source_fixture_id").notNull(),
    stage: stageEnum("stage").notNull(),
    /** Generic period link (Phase 9). Nullable during transition; standings
     * fall back to stage-code matching when null. */
    scoringPeriodId: integer("scoring_period_id").references(
      () => scoringPeriod.id,
      { onDelete: "restrict" },
    ),
    homeTeamId: integer("home_team_id")
      .notNull()
      .references(() => nationalTeam.id, { onDelete: "restrict" }),
    awayTeamId: integer("away_team_id")
      .notNull()
      .references(() => nationalTeam.id, { onDelete: "restrict" }),
    kickoffUtc: timestamp("kickoff_utc", { withTimezone: true }).notNull(),
    status: fixtureStatusEnum("status").notNull().default("SCHEDULED"),
    homeScore: integer("home_score"),
    awayScore: integer("away_score"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    sourceFixtureIdUq: uniqueIndex("fixture_source_fixture_id_uq").on(t.sourceFixtureId),
  }),
);

// --- stat_line --------------------------------------------------------------

/**
 * IMMUTABLE raw per-player, per-fixture stats. Only the ingestion path
 * writes it; team_conceded_in_regulation_and_et excludes shootouts.
 */
export const statLine = pgTable(
  "stat_line",
  {
    playerId: integer("player_id")
      .notNull()
      .references(() => player.id, { onDelete: "restrict" }),
    fixtureId: integer("fixture_id")
      .notNull()
      .references(() => fixture.id, { onDelete: "restrict" }),

    minutesPlayed: integer("minutes_played").notNull().default(0),
    goals: integer("goals").notNull().default(0),
    assists: integer("assists").notNull().default(0),
    saves: integer("saves").notNull().default(0),
    yellowCards: integer("yellow_cards").notNull().default(0),
    redCards: integer("red_cards").notNull().default(0),
    penaltiesScored: integer("penalties_scored").notNull().default(0),
    penaltiesMissed: integer("penalties_missed").notNull().default(0),
    penaltiesSaved: integer("penalties_saved").notNull().default(0),
    ownGoals: integer("own_goals").notNull().default(0),
    teamConcededInRegulationAndEt: integer("team_conceded_in_regulation_and_et")
      .notNull()
      .default(0),
    /** Goals the player's team SCORED in regulation + ET. Powers the keeper
     * "game won" bonus (scored > conceded). Excludes shootout goals. */
    teamScoredInRegulationAndEt: integer("team_scored_in_regulation_and_et")
      .notNull()
      .default(0),

    // --- Detailed-action counts (v2) ----------------------------------------
    // Populated by richer providers (Sportmonks / Opta) or by hand. Default 0
    // so a provider that can't supply them simply contributes nothing.
    shotsOnTarget: integer("shots_on_target").notNull().default(0),
    shotsOffTarget: integer("shots_off_target").notNull().default(0),
    tacklesSuccessful: integer("tackles_successful").notNull().default(0),
    crosses: integer("crosses").notNull().default(0),
    passesCompleted: integer("passes_completed").notNull().default(0),
    /** Playmaking: key passes (a pass leading to a shot). */
    keyPasses: integer("key_passes").notNull().default(0),
    /** Playmaking: big chances created. */
    bigChancesCreated: integer("big_chances_created").notNull().default(0),
    /** Goals conceded charged to this player as keeper (= team conceded for a
     * GK who played the full match; provider per-player value otherwise). */
    goalsConceded: integer("goals_conceded").notNull().default(0),

    // --- Manual edit lock ---------------------------------------------------
    // When true, the provider ingest path will NOT overwrite this row, so
    // hand-entered corrections (e.g. saves split across a keeper substitution)
    // survive the next ingest. Set by the admin stat editor.
    manuallyEdited: boolean("manually_edited").notNull().default(false),
    manualNote: text("manual_note"),

    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    sourceRevision: text("source_revision").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.playerId, t.fixtureId] }),
  }),
);

// --- score_entry ------------------------------------------------------------

/**
 * DERIVED per-player, per-fixture points. Disposable; recomputable from
 * stat_line. PK includes ruleset_version so what-if rulesets coexist.
 */
export const scoreEntry = pgTable(
  "score_entry",
  {
    playerId: integer("player_id")
      .notNull()
      .references(() => player.id, { onDelete: "restrict" }),
    fixtureId: integer("fixture_id")
      .notNull()
      .references(() => fixture.id, { onDelete: "restrict" }),
    rulesetVersion: text("ruleset_version").notNull(),
    /** Real (not integer): the v2 rules introduce fractional values (0.5,
     * 0.05). Always rounded to 2dp by the scoring engine. */
    points: real("points").notNull(),
    breakdown: jsonb("breakdown").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.playerId, t.fixtureId, t.rulesetVersion],
    }),
    fixtureIdx: index("score_entry_fixture_id_idx").on(t.fixtureId),
    rulesetIdx: index("score_entry_ruleset_version_idx").on(t.rulesetVersion),
  }),
);

// --- Type helpers ------------------------------------------------------------

export type NationalTeamRow = typeof nationalTeam.$inferSelect;
export type NationalTeamInsert = typeof nationalTeam.$inferInsert;
export type PlayerRow = typeof player.$inferSelect;
export type PlayerInsert = typeof player.$inferInsert;
export type FixtureRow = typeof fixture.$inferSelect;
export type FixtureInsert = typeof fixture.$inferInsert;
export type StatLineRow = typeof statLine.$inferSelect;
export type StatLineInsert = typeof statLine.$inferInsert;
export type ScoreEntryRow = typeof scoreEntry.$inferSelect;
export type ScoreEntryInsert = typeof scoreEntry.$inferInsert;
