/**
 * World Cup Fantasy - leagues domain tables.
 *
 * Phase 3 (leagues): manager, league, league_membership, league_invite,
 *                    fantasy_team, roster_slot.
 *
 * Invariants worth remembering:
 *   - A real player may be drafted at most once per league: roster_slot has
 *     a unique (league_id, player_id).
 *   - A manager has exactly one fantasy_team per league.
 */

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import {
  inviteStatusEnum,
  leagueRoleEnum,
  leagueStatusEnum,
  positionEnum,
} from "./enums.js";
import { player } from "./football.js";

// --- manager ----------------------------------------------------------------

export const manager = pgTable(
  "manager",
  {
    id: serial("id").primaryKey(),
    firebaseUid: text("firebase_uid").notNull(),
    displayName: text("display_name").notNull(),
    email: text("email").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    firebaseUidUq: uniqueIndex("manager_firebase_uid_uq").on(t.firebaseUid),
  }),
);

// --- league -----------------------------------------------------------------

export const league = pgTable("league", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  createdByManagerId: integer("created_by_manager_id")
    .notNull()
    .references(() => manager.id, { onDelete: "restrict" }),
  scoringRuleset: jsonb("scoring_ruleset").notNull(),
  maxManagers: integer("max_managers").notNull().default(24),
  rosterSize: integer("roster_size").notNull().default(23),
  status: leagueStatusEnum("status").notNull().default("SETUP"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

// --- league_membership ------------------------------------------------------

export const leagueMembership = pgTable(
  "league_membership",
  {
    leagueId: integer("league_id")
      .notNull()
      .references(() => league.id, { onDelete: "restrict" }),
    managerId: integer("manager_id")
      .notNull()
      .references(() => manager.id, { onDelete: "restrict" }),
    role: leagueRoleEnum("role").notNull().default("MEMBER"),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.leagueId, t.managerId] }),
    managerIdx: index("league_membership_manager_id_idx").on(t.managerId),
  }),
);

// --- league_invite ----------------------------------------------------------

export const leagueInvite = pgTable(
  "league_invite",
  {
    id: serial("id").primaryKey(),
    leagueId: integer("league_id")
      .notNull()
      .references(() => league.id, { onDelete: "restrict" }),
    token: text("token").notNull(),
    email: text("email"),
    status: inviteStatusEnum("status").notNull().default("PENDING"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedByManagerId: integer("accepted_by_manager_id").references(
      () => manager.id,
      { onDelete: "restrict" },
    ),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    tokenUq: uniqueIndex("league_invite_token_uq").on(t.token),
    leagueIdx: index("league_invite_league_id_idx").on(t.leagueId),
  }),
);

// --- fantasy_team -----------------------------------------------------------

export const fantasyTeam = pgTable(
  "fantasy_team",
  {
    id: serial("id").primaryKey(),
    leagueId: integer("league_id")
      .notNull()
      .references(() => league.id, { onDelete: "restrict" }),
    managerId: integer("manager_id")
      .notNull()
      .references(() => manager.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    leagueManagerUq: uniqueIndex("fantasy_team_league_id_manager_id_uq").on(
      t.leagueId,
      t.managerId,
    ),
  }),
);

// --- roster_slot ------------------------------------------------------------

/**
 * One player's membership on one fantasy_team. league_id is denormalized
 * so the unique (league_id, player_id) enforces "drafted at most once per
 * league". drafted_position snapshots player.position at draft time.
 */
export const rosterSlot = pgTable(
  "roster_slot",
  {
    fantasyTeamId: integer("fantasy_team_id")
      .notNull()
      .references(() => fantasyTeam.id, { onDelete: "restrict" }),
    playerId: integer("player_id")
      .notNull()
      .references(() => player.id, { onDelete: "restrict" }),
    leagueId: integer("league_id")
      .notNull()
      .references(() => league.id, { onDelete: "restrict" }),
    draftedPosition: positionEnum("drafted_position").notNull(),
    draftedAt: timestamp("drafted_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.fantasyTeamId, t.playerId] }),
    leaguePlayerUq: uniqueIndex("roster_slot_league_id_player_id_uq").on(
      t.leagueId,
      t.playerId,
    ),
  }),
);

// --- Type helpers ------------------------------------------------------------

export type ManagerRow = typeof manager.$inferSelect;
export type ManagerInsert = typeof manager.$inferInsert;
export type LeagueRow = typeof league.$inferSelect;
export type LeagueInsert = typeof league.$inferInsert;
export type LeagueMembershipRow = typeof leagueMembership.$inferSelect;
export type LeagueMembershipInsert = typeof leagueMembership.$inferInsert;
export type LeagueInviteRow = typeof leagueInvite.$inferSelect;
export type LeagueInviteInsert = typeof leagueInvite.$inferInsert;
export type FantasyTeamRow = typeof fantasyTeam.$inferSelect;
export type FantasyTeamInsert = typeof fantasyTeam.$inferInsert;
export type RosterSlotRow = typeof rosterSlot.$inferSelect;
export type RosterSlotInsert = typeof rosterSlot.$inferInsert;
