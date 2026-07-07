/**
 * World Cup Fantasy - chips domain tables (Phase 9 Priority 3).
 *
 * Chips are one-shot, per-period power-ups applied as a READ-TIME OVERLAY
 * in the standings computation - score_entry is never written. Gated by
 * the `chips` feature flag; leagues without it never read these tables.
 *
 *   - period_captain: a best-ball manager's nominated captain for one
 *     scoring period (x2, or x3 with TRIPLE_CAPTAIN). SET_LINEUP leagues
 *     do NOT use this table - their captain lives on the lineup row.
 *   - chip_play: one chip spent on one period.
 *
 * Invariants worth remembering:
 *   - Each chip is usable once per team: unique (league, team, chip).
 *   - Chips do not stack: unique (league, team, period).
 *   - Selections lock at the period's first kickoff (service-enforced).
 */

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  primaryKey,
  serial,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { chipTypeEnum } from "./enums.js";
import { scoringPeriod } from "./competition.js";
import { player } from "./football.js";
import { fantasyTeam, league } from "./leagues.js";

// --- period_captain -------------------------------------------------------------

export const periodCaptain = pgTable(
  "period_captain",
  {
    fantasyTeamId: integer("fantasy_team_id")
      .notNull()
      .references(() => fantasyTeam.id, { onDelete: "restrict" }),
    scoringPeriodId: integer("scoring_period_id")
      .notNull()
      .references(() => scoringPeriod.id, { onDelete: "restrict" }),
    playerId: integer("player_id")
      .notNull()
      .references(() => player.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.fantasyTeamId, t.scoringPeriodId] }),
  }),
);

// --- chip_play --------------------------------------------------------------------

export const chipPlay = pgTable(
  "chip_play",
  {
    id: serial("id").primaryKey(),
    leagueId: integer("league_id")
      .notNull()
      .references(() => league.id, { onDelete: "restrict" }),
    fantasyTeamId: integer("fantasy_team_id")
      .notNull()
      .references(() => fantasyTeam.id, { onDelete: "restrict" }),
    chip: chipTypeEnum("chip").notNull(),
    scoringPeriodId: integer("scoring_period_id")
      .notNull()
      .references(() => scoringPeriod.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    oneUseUq: uniqueIndex("chip_play_league_team_chip_uq").on(
      t.leagueId,
      t.fantasyTeamId,
      t.chip,
    ),
    noStackUq: uniqueIndex("chip_play_league_team_period_uq").on(
      t.leagueId,
      t.fantasyTeamId,
      t.scoringPeriodId,
    ),
    leagueIdx: index("chip_play_league_id_idx").on(t.leagueId),
  }),
);

// --- Type helpers -------------------------------------------------------------------

export type PeriodCaptainRow = typeof periodCaptain.$inferSelect;
export type PeriodCaptainInsert = typeof periodCaptain.$inferInsert;
export type ChipPlayRow = typeof chipPlay.$inferSelect;
export type ChipPlayInsert = typeof chipPlay.$inferInsert;
