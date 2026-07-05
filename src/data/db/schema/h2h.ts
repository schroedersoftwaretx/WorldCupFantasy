/**
 * World Cup Fantasy - head-to-head domain tables (Phase 9 Priority 2).
 *
 * A matchup pairs two fantasy teams for one scoring period. ONLY the
 * schedule is stored; results are always DERIVED from period totals (the
 * same standings read every other view uses), so a stat correction
 * automatically corrects every matchup - the same philosophy as standings.
 *
 * Invariants worth remembering:
 *   - Gated by the `head_to_head` feature flag; a best-ball or set-lineup
 *     league without the flag never reads or writes this table.
 *   - A team appears at most once per (league, period) - enforced by the
 *     two unique indexes plus the generator writing whole schedules
 *     transactionally. A team absent from a period simply has a bye.
 *   - Period totals come from whatever base format the league uses
 *     (BEST_BALL optimizer or SET_LINEUP submissions).
 */

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  serial,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { scoringPeriod } from "./competition.js";
import { fantasyTeam, league } from "./leagues.js";

// --- matchup ------------------------------------------------------------------

export const matchup = pgTable(
  "matchup",
  {
    id: serial("id").primaryKey(),
    leagueId: integer("league_id")
      .notNull()
      .references(() => league.id, { onDelete: "restrict" }),
    scoringPeriodId: integer("scoring_period_id")
      .notNull()
      .references(() => scoringPeriod.id, { onDelete: "restrict" }),
    homeFantasyTeamId: integer("home_fantasy_team_id")
      .notNull()
      .references(() => fantasyTeam.id, { onDelete: "restrict" }),
    awayFantasyTeamId: integer("away_fantasy_team_id")
      .notNull()
      .references(() => fantasyTeam.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    homeUq: uniqueIndex("matchup_league_period_home_uq").on(
      t.leagueId,
      t.scoringPeriodId,
      t.homeFantasyTeamId,
    ),
    awayUq: uniqueIndex("matchup_league_period_away_uq").on(
      t.leagueId,
      t.scoringPeriodId,
      t.awayFantasyTeamId,
    ),
    leagueIdx: index("matchup_league_id_idx").on(t.leagueId),
  }),
);

// --- Type helpers ---------------------------------------------------------------

export type MatchupRow = typeof matchup.$inferSelect;
export type MatchupInsert = typeof matchup.$inferInsert;
