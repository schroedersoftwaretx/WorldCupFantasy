/**
 * World Cup Fantasy - competition domain tables (Phase 9).
 *
 * Makes "what competition is this league playing, and what are its scoring
 * periods" data instead of the hardcoded stage enum:
 *   - competition:    one row per real-world competition-season, e.g.
 *                     "FIFA World Cup 2026", "Premier League 2026/27".
 *   - scoring_period: one row per scoring period of a competition - WC
 *                     stages, PL gameweeks 1-38, CL matchdays + KO rounds.
 *
 * Invariants worth remembering:
 *   - scoring_period is unique on (competition_id, ordinal); ordinal is the
 *     1-based tournament order the standings loop iterates in.
 *   - stage_code is set only for periods that mirror a stage enum value (the
 *     seeded World Cup periods); it is how fixtures without a
 *     scoring_period_id fall back to stage-based matching.
 *   - The stage enum + fixture.stage stay in place (WC tie-breakers and
 *     standings_snapshot still reference them). Do not remove them here.
 */

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { competitionKindEnum, stageEnum } from "./enums.js";

// --- competition --------------------------------------------------------------

export const competition = pgTable(
  "competition",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    kind: competitionKindEnum("kind").notNull(),
    /** Human season tag, e.g. "2026" or "2026/27". */
    seasonLabel: text("season_label").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    nameSeasonUq: uniqueIndex("competition_name_season_label_uq").on(
      t.name,
      t.seasonLabel,
    ),
  }),
);

// --- scoring_period -----------------------------------------------------------

/**
 * The generic replacement for the SCORING_PERIODS stage list. One row per
 * period, ordered by ordinal within a competition.
 */
export const scoringPeriod = pgTable(
  "scoring_period",
  {
    id: serial("id").primaryKey(),
    competitionId: integer("competition_id")
      .notNull()
      .references(() => competition.id, { onDelete: "restrict" }),
    /** 1-based order the standings loop iterates in. */
    ordinal: integer("ordinal").notNull(),
    /** Display label, e.g. "GW1", "Group 1", "Final". */
    label: text("label").notNull(),
    /** Set only when the period mirrors a stage enum value (cups). */
    stageCode: stageEnum("stage_code"),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    competitionOrdinalUq: uniqueIndex("scoring_period_competition_id_ordinal_uq").on(
      t.competitionId,
      t.ordinal,
    ),
    competitionIdx: index("scoring_period_competition_id_idx").on(t.competitionId),
  }),
);

// --- Type helpers ---------------------------------------------------------------

export type CompetitionRow = typeof competition.$inferSelect;
export type CompetitionInsert = typeof competition.$inferInsert;
export type ScoringPeriodRow = typeof scoringPeriod.$inferSelect;
export type ScoringPeriodInsert = typeof scoringPeriod.$inferInsert;
