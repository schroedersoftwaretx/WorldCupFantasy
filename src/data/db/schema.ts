/**
 * World Cup Fantasy - database schema.
 *
 * Phase 1 (data spine): national_team, player, fixture, stat_line.
 * Phase 2 (scoring):     score_entry.
 * Phase 3 (leagues):     manager, league, league_membership, league_invite,
 *                        fantasy_team, roster_slot.
 * Phase 4 (draft):       draft_room, draft_order, draft_pick,
 *                        draft_notification (+ player.draft_rank).
 * Phase 6 (projections): match_odds, projected_score_entry.
 *
 * Invariants worth remembering:
 *   - stat_line is the immutable SOURCE OF TRUTH; only the ingestion path
 *     writes it. score_entry is fully recomputable from it.
 *   - A real player may be drafted at most once per league: roster_slot has
 *     a unique (league_id, player_id).
 *   - A manager has exactly one fantasy_team per league.
 *   - A league has at most one draft_room.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// --- Enums -------------------------------------------------------------------

export const positionEnum = pgEnum("position", ["GK", "DEF", "MID", "FWD"]);
export const teamStatusEnum = pgEnum("team_status", ["ACTIVE", "ELIMINATED"]);
export const playerStatusEnum = pgEnum("player_status", ["ACTIVE", "UNKNOWN"]);
export const stageEnum = pgEnum("stage", [
  "GROUP_1",
  "GROUP_2",
  "GROUP_3",
  "R32",
  "R16",
  "QF",
  "SF",
  "THIRD_PLACE",
  "FINAL",
]);
export const fixtureStatusEnum = pgEnum("fixture_status", [
  "SCHEDULED",
  "LIVE",
  "FINISHED",
]);

export const leagueStatusEnum = pgEnum("league_status", [
  "SETUP",
  "DRAFTING",
  "ACTIVE",
  "COMPLETE",
]);
export const leagueRoleEnum = pgEnum("league_role", ["OWNER", "MEMBER"]);
export const inviteStatusEnum = pgEnum("invite_status", [
  "PENDING",
  "ACCEPTED",
  "REVOKED",
]);

/** Draft lifecycle. */
export const draftStatusEnum = pgEnum("draft_status", [
  "PENDING",
  "IN_PROGRESS",
  "COMPLETE",
]);
/** Kinds of notification emitted by the draft. */
export const draftNotificationTypeEnum = pgEnum("draft_notification_type", [
  "DRAFT_STARTED",
  "ON_THE_CLOCK",
  "PICK_MADE",
  "AUTOPICK_MADE",
  "DRAFT_COMPLETE",
]);
/** Delivery state of a notification. */
export const notificationStatusEnum = pgEnum("notification_status", [
  "PENDING",
  "SENT",
  "FAILED",
]);

// --- App-wide notification hub (Phase 0) ------------------------------------

/**
 * Channel a {@link notification} is delivered through. IN_APP rows surface in
 * the bell/inbox; EMAIL rows are delivered out-of-band via the notify
 * transport (Resend).
 */
export const notificationChannelEnum = pgEnum("notification_channel", [
  "IN_APP",
  "EMAIL",
]);

/**
 * Lifecycle of an app-wide {@link notification}. Distinct from the draft's
 * `notification_status` enum because in-app notifications add a READ state.
 *   - IN_APP: created SENT (delivered to the inbox); READ once opened.
 *   - EMAIL:  created PENDING; SENT / FAILED after a delivery attempt.
 */
export const appNotificationStatusEnum = pgEnum("app_notification_status", [
  "PENDING",
  "SENT",
  "FAILED",
  "READ",
]);

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

// --- draft_room -------------------------------------------------------------

/**
 * The async snake draft for one league. At most one per league.
 *
 * current_pick_number is the 1-based overall pick on the clock (NULL when
 * PENDING or COMPLETE). current_pick_deadline is when that pick auto-fires
 * an autopick. total_picks = managers * roster_size, frozen at start.
 */
export const draftRoom = pgTable(
  "draft_room",
  {
    id: serial("id").primaryKey(),
    leagueId: integer("league_id")
      .notNull()
      .references(() => league.id, { onDelete: "restrict" }),
    status: draftStatusEnum("status").notNull().default("PENDING"),
    /** Per-pick timer in hours (fractional OK, e.g. 0.25 = 15 min). */
    pickTimerHours: real("pick_timer_hours").notNull().default(12),
    /** managers * roster_size; 0 until the draft starts. */
    totalPicks: integer("total_picks").notNull().default(0),
    /** 1-based overall pick on the clock; NULL when PENDING / COMPLETE. */
    currentPickNumber: integer("current_pick_number"),
    /** When the current pick auto-fires; NULL when not IN_PROGRESS. */
    currentPickDeadline: timestamp("current_pick_deadline", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    leagueUq: uniqueIndex("draft_room_league_id_uq").on(t.leagueId),
  }),
);

// --- draft_order ------------------------------------------------------------

/**
 * The round-1 pick order. slot 1..N maps to a fantasy_team; the snake
 * pattern (odd rounds forward, even rounds reversed) is derived from this.
 */
export const draftOrder = pgTable(
  "draft_order",
  {
    draftRoomId: integer("draft_room_id")
      .notNull()
      .references(() => draftRoom.id, { onDelete: "restrict" }),
    slot: integer("slot").notNull(),
    fantasyTeamId: integer("fantasy_team_id")
      .notNull()
      .references(() => fantasyTeam.id, { onDelete: "restrict" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.draftRoomId, t.slot] }),
    teamUq: uniqueIndex("draft_order_room_team_uq").on(t.draftRoomId, t.fantasyTeamId),
  }),
);

// --- draft_pick -------------------------------------------------------------

/** Append-only audit log: one row per completed pick. */
export const draftPick = pgTable(
  "draft_pick",
  {
    id: serial("id").primaryKey(),
    draftRoomId: integer("draft_room_id")
      .notNull()
      .references(() => draftRoom.id, { onDelete: "restrict" }),
    pickNumber: integer("pick_number").notNull(),
    round: integer("round").notNull(),
    fantasyTeamId: integer("fantasy_team_id")
      .notNull()
      .references(() => fantasyTeam.id, { onDelete: "restrict" }),
    playerId: integer("player_id")
      .notNull()
      .references(() => player.id, { onDelete: "restrict" }),
    /** True when the pick was made by the constraint-aware autopick. */
    isAutopick: boolean("is_autopick").notNull().default(false),
    pickedAt: timestamp("picked_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    pickUq: uniqueIndex("draft_pick_room_pick_number_uq").on(
      t.draftRoomId,
      t.pickNumber,
    ),
  }),
);

// --- draft_notification -----------------------------------------------------

/**
 * Durable notification queue. Every notification the draft emits is
 * persisted here first (status PENDING); the Notifier then attempts
 * delivery and marks SENT / FAILED. Because the row is written before
 * delivery, a notification is never lost if email delivery is deferred or
 * fails - it can be retried from this table.
 */
export const draftNotification = pgTable(
  "draft_notification",
  {
    id: serial("id").primaryKey(),
    draftRoomId: integer("draft_room_id")
      .notNull()
      .references(() => draftRoom.id, { onDelete: "restrict" }),
    managerId: integer("manager_id")
      .notNull()
      .references(() => manager.id, { onDelete: "restrict" }),
    fantasyTeamId: integer("fantasy_team_id").references(() => fantasyTeam.id, {
      onDelete: "restrict",
    }),
    type: draftNotificationTypeEnum("type").notNull(),
    status: notificationStatusEnum("status").notNull().default("PENDING"),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => ({
    roomIdx: index("draft_notification_room_id_idx").on(t.draftRoomId),
    statusIdx: index("draft_notification_status_idx").on(t.status),
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
export type DraftRoomRow = typeof draftRoom.$inferSelect;
export type DraftRoomInsert = typeof draftRoom.$inferInsert;
export type DraftOrderRow = typeof draftOrder.$inferSelect;
export type DraftOrderInsert = typeof draftOrder.$inferInsert;
export type DraftPickRow = typeof draftPick.$inferSelect;
export type DraftPickInsert = typeof draftPick.$inferInsert;
export type DraftNotificationRow = typeof draftNotification.$inferSelect;
export type DraftNotificationInsert = typeof draftNotification.$inferInsert;

export type Stage = (typeof stageEnum.enumValues)[number];
export type Position = (typeof positionEnum.enumValues)[number];
export type FixtureStatus = (typeof fixtureStatusEnum.enumValues)[number];
export type TeamStatus = (typeof teamStatusEnum.enumValues)[number];
export type PlayerStatus = (typeof playerStatusEnum.enumValues)[number];
export type LeagueStatus = (typeof leagueStatusEnum.enumValues)[number];
export type LeagueRole = (typeof leagueRoleEnum.enumValues)[number];
export type InviteStatus = (typeof inviteStatusEnum.enumValues)[number];
export type DraftStatus = (typeof draftStatusEnum.enumValues)[number];
export type DraftNotificationType = (typeof draftNotificationTypeEnum.enumValues)[number];
export type NotificationStatus = (typeof notificationStatusEnum.enumValues)[number];

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

// --- standings_snapshot -------------------------------------------------------

/**
 * A persisted standings snapshot: one row per (league, stage, fantasy team)
 * recording the team's CUMULATIVE rank and total through the end of that
 * scoring period. Written by the score-recompute paths (cron + the owner's
 * manual recompute) so the standings page can show rank movement between
 * stages even if older score_entry rows are later corrected.
 *
 * Cheap by construction: at most leagues x 9 stages x 24 teams rows.
 */
export const standingsSnapshot = pgTable(
  "standings_snapshot",
  {
    leagueId: integer("league_id")
      .notNull()
      .references(() => league.id, { onDelete: "restrict" }),
    stage: stageEnum("stage").notNull(),
    fantasyTeamId: integer("fantasy_team_id")
      .notNull()
      .references(() => fantasyTeam.id, { onDelete: "restrict" }),
    /** 1-based rank by cumulative total through this stage (ties share). */
    rank: integer("rank").notNull(),
    /** Cumulative best-ball total through this stage. */
    total: real("total").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.leagueId, t.stage, t.fantasyTeamId] }),
    leagueIdx: index("standings_snapshot_league_id_idx").on(t.leagueId),
  }),
);

// --- notification (Phase 0 hub) ---------------------------------------------

/**
 * App-wide durable notification queue. Generalizes the draft-only
 * `draft_notification` table into something any feature can write to, with the
 * same write-row-then-deliver guarantee: the row is persisted (PENDING for
 * EMAIL, SENT for IN_APP) before any out-of-band delivery, so a notification is
 * never lost if delivery is deferred or fails.
 *
 * `type` is free text (not an enum) so each feature phase can introduce its own
 * kinds without a migration. `dedupe_key` (when set) suppresses repeats: the
 * unique index on (manager_id, channel, dedupe_key) means re-enqueuing the same
 * logical event for the same manager+channel is a no-op.
 */
export const notification = pgTable(
  "notification",
  {
    id: serial("id").primaryKey(),
    managerId: integer("manager_id")
      .notNull()
      .references(() => manager.id, { onDelete: "restrict" }),
    /** The league this concerns, when league-scoped; NULL for app-wide. */
    leagueId: integer("league_id").references(() => league.id, {
      onDelete: "restrict",
    }),
    /** Extensible per-phase kind, e.g. "DRAFT_STARTED", "CHAT_MENTION". */
    type: text("type").notNull(),
    channel: notificationChannelEnum("channel").notNull(),
    status: appNotificationStatusEnum("status").notNull().default("PENDING"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** In-app deep link, e.g. "/leagues/3/draft". NULL when not applicable. */
    link: text("link"),
    /** When set, suppresses repeats per (manager, channel). */
    dedupeKey: text("dedupe_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => ({
    managerIdx: index("notification_manager_id_idx").on(t.managerId),
    statusIdx: index("notification_status_idx").on(t.status),
    dedupeUq: uniqueIndex("notification_manager_channel_dedupe_uq").on(
      t.managerId,
      t.channel,
      t.dedupeKey,
    ),
  }),
);

// --- league_feature_flag (Phase 0) ------------------------------------------

/**
 * Per-league feature toggle. A row exists only for a flag a commissioner has
 * explicitly set; absent rows fall back to the typed defaults in
 * `src/data/league/feature-flags.ts`. `config` carries optional per-feature
 * settings (jsonb) for flags that need them.
 */
export const leagueFeatureFlag = pgTable(
  "league_feature_flag",
  {
    leagueId: integer("league_id")
      .notNull()
      .references(() => league.id, { onDelete: "restrict" }),
    flag: text("flag").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    config: jsonb("config"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.leagueId, t.flag] }),
    leagueIdx: index("league_feature_flag_league_id_idx").on(t.leagueId),
  }),
);

// --- notification_preference (Phase 8) --------------------------------------

/**
 * Per-manager, per-category, per-channel notification toggle. Account-level
 * (not league-scoped). A row exists only for a (manager, category, channel)
 * the manager has explicitly set; an absent row falls back to enabled (an
 * opt-out model). `category` mirrors the free-text `notification.type`
 * (e.g. "ON_THE_CLOCK"); `channel` reuses the notification channel enum.
 */
export const notificationPreference = pgTable(
  "notification_preference",
  {
    managerId: integer("manager_id")
      .notNull()
      .references(() => manager.id, { onDelete: "restrict" }),
    category: text("category").notNull(),
    channel: notificationChannelEnum("channel").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.managerId, t.category, t.channel] }),
    managerIdx: index("notification_preference_manager_id_idx").on(t.managerId),
  }),
);

// --- draft_queue (Phase 8) --------------------------------------------------

/**
 * One manager's ranked draft targets for one draft room. Lower `rank` = higher
 * priority. The autopick consults this (still-available, position-legal)
 * before falling back to `player.draft_rank`. Does not affect snake order or
 * the pick timer.
 */
export const draftQueue = pgTable(
  "draft_queue",
  {
    draftRoomId: integer("draft_room_id")
      .notNull()
      .references(() => draftRoom.id, { onDelete: "restrict" }),
    fantasyTeamId: integer("fantasy_team_id")
      .notNull()
      .references(() => fantasyTeam.id, { onDelete: "restrict" }),
    playerId: integer("player_id")
      .notNull()
      .references(() => player.id, { onDelete: "restrict" }),
    rank: integer("rank").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.draftRoomId, t.fantasyTeamId, t.playerId] }),
    rankIdx: index("draft_queue_room_team_rank_idx").on(
      t.draftRoomId,
      t.fantasyTeamId,
      t.rank,
    ),
  }),
);

// --- Type helpers (continued) ------------------------------------------------

export type NotificationRow = typeof notification.$inferSelect;
export type NotificationInsert = typeof notification.$inferInsert;
export type NotificationChannel = (typeof notificationChannelEnum.enumValues)[number];
export type NotificationPreferenceRow = typeof notificationPreference.$inferSelect;
export type NotificationPreferenceInsert =
  typeof notificationPreference.$inferInsert;
export type DraftQueueRow = typeof draftQueue.$inferSelect;
export type DraftQueueInsert = typeof draftQueue.$inferInsert;
export type AppNotificationStatus =
  (typeof appNotificationStatusEnum.enumValues)[number];
export type LeagueFeatureFlagRow = typeof leagueFeatureFlag.$inferSelect;
export type LeagueFeatureFlagInsert = typeof leagueFeatureFlag.$inferInsert;

export type MatchOddsRow = typeof matchOdds.$inferSelect;
export type MatchOddsInsert = typeof matchOdds.$inferInsert;
export type ProjectedScoreEntryRow = typeof projectedScoreEntry.$inferSelect;
export type ProjectedScoreEntryInsert = typeof projectedScoreEntry.$inferInsert;
export type StageOddsRow = typeof stageOdds.$inferSelect;
export type StageOddsInsert = typeof stageOdds.$inferInsert;
export type StandingsSnapshotRow = typeof standingsSnapshot.$inferSelect;
export type StandingsSnapshotInsert = typeof standingsSnapshot.$inferInsert;
