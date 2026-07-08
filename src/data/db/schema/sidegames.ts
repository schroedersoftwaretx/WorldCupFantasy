/**
 * World Cup Fantasy - side-games tables (phase-05 subset: survivor).
 *
 * Survivor pool: each stage, pick one nation to WIN; a nation is usable
 * once per entry; a wrong (or missed) pick costs a life; at zero lives the
 * entry is eliminated at that stage. Gated by the `survivor` feature flag.
 *
 * Invariants worth remembering:
 *   - One entry per (league, manager).
 *   - One pick per (entry, stage) - the PK. national_team_id NULL encodes a
 *     MISSED pick, written by resolution when a joined entry skipped a
 *     stage that started after they joined.
 *   - resolved_outcome is written exactly once per pick ("WIN"/"LOSS"),
 *     which is what makes cron resolution idempotent. Stages are inherently
 *     WC-style rounds, so this keys on the stage enum (not scoring_period).
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
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { stageEnum } from "./enums.js";
import { nationalTeam } from "./football.js";
import { league, manager } from "./leagues.js";

// --- survivor_entry -------------------------------------------------------------

export const survivorEntry = pgTable(
  "survivor_entry",
  {
    id: serial("id").primaryKey(),
    leagueId: integer("league_id")
      .notNull()
      .references(() => league.id, { onDelete: "restrict" }),
    managerId: integer("manager_id")
      .notNull()
      .references(() => manager.id, { onDelete: "restrict" }),
    livesRemaining: integer("lives_remaining").notNull().default(1),
    eliminatedAtStage: stageEnum("eliminated_at_stage"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    leagueManagerUq: uniqueIndex("survivor_entry_league_id_manager_id_uq").on(
      t.leagueId,
      t.managerId,
    ),
    leagueIdx: index("survivor_entry_league_id_idx").on(t.leagueId),
  }),
);

// --- survivor_pick ----------------------------------------------------------------

export const survivorPick = pgTable(
  "survivor_pick",
  {
    survivorEntryId: integer("survivor_entry_id")
      .notNull()
      .references(() => survivorEntry.id, { onDelete: "restrict" }),
    stage: stageEnum("stage").notNull(),
    /** NULL = the entry missed this stage's pick (charged by resolution). */
    nationalTeamId: integer("national_team_id").references(() => nationalTeam.id, {
      onDelete: "restrict",
    }),
    /** "WIN" | "LOSS"; NULL until the stage resolves. */
    resolvedOutcome: text("resolved_outcome"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.survivorEntryId, t.stage] }),
  }),
);

// --- Type helpers -------------------------------------------------------------------

export type SurvivorEntryRow = typeof survivorEntry.$inferSelect;
export type SurvivorEntryInsert = typeof survivorEntry.$inferInsert;
export type SurvivorPickRow = typeof survivorPick.$inferSelect;
export type SurvivorPickInsert = typeof survivorPick.$inferInsert;
