/**
 * World Cup Fantasy - lineup domain tables (Phase 9, SET_LINEUP format).
 *
 * A lineup is one fantasy team's SUBMITTED starting XI for one scoring
 * period, with a captain (double points) and optional vice-captain
 * (promoted when the captain does not feature). Only leagues with
 * league.format = 'SET_LINEUP' read or write this table; the best-ball
 * path never touches it.
 *
 * Invariants worth remembering:
 *   - One lineup per (fantasy_team_id, scoring_period_id) - the PK.
 *   - player_ids is a jsonb array of exactly 11 rostered player ids forming
 *     a legal formation; captain (and vice, if set) must be in the XI.
 *     Enforced by src/data/lineup/service.ts, not the DB.
 *   - Submissions lock at the period's first kickoff (service-enforced).
 *   - Scoring rolls a lineup FORWARD: a period with no row uses the most
 *     recent submitted lineup of an earlier period (FPL-style).
 */

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
} from "drizzle-orm/pg-core";

import { scoringPeriod } from "./competition.js";
import { player } from "./football.js";
import { fantasyTeam } from "./leagues.js";

// --- lineup -------------------------------------------------------------------

export const lineup = pgTable(
  "lineup",
  {
    fantasyTeamId: integer("fantasy_team_id")
      .notNull()
      .references(() => fantasyTeam.id, { onDelete: "restrict" }),
    scoringPeriodId: integer("scoring_period_id")
      .notNull()
      .references(() => scoringPeriod.id, { onDelete: "restrict" }),
    /** Exactly 11 player ids (jsonb array of integers). */
    playerIds: jsonb("player_ids").notNull(),
    captainPlayerId: integer("captain_player_id")
      .notNull()
      .references(() => player.id, { onDelete: "restrict" }),
    viceCaptainPlayerId: integer("vice_captain_player_id").references(
      () => player.id,
      { onDelete: "restrict" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.fantasyTeamId, t.scoringPeriodId] }),
    periodIdx: index("lineup_scoring_period_id_idx").on(t.scoringPeriodId),
  }),
);

// --- Type helpers ---------------------------------------------------------------

export type LineupRow = typeof lineup.$inferSelect;
export type LineupInsert = typeof lineup.$inferInsert;
