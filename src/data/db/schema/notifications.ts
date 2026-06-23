/**
 * World Cup Fantasy - notifications / standings / feature-flag tables.
 *
 * standings_snapshot (rank movement), the Phase 0 app-wide notification hub
 * (notification, league_feature_flag) and the Phase 8 notification_preference.
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
  appNotificationStatusEnum,
  notificationChannelEnum,
  stageEnum,
} from "./enums.js";
import { fantasyTeam, league, manager } from "./leagues.js";

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

// --- Type helpers ------------------------------------------------------------

export type StandingsSnapshotRow = typeof standingsSnapshot.$inferSelect;
export type StandingsSnapshotInsert = typeof standingsSnapshot.$inferInsert;
export type NotificationRow = typeof notification.$inferSelect;
export type NotificationInsert = typeof notification.$inferInsert;
export type LeagueFeatureFlagRow = typeof leagueFeatureFlag.$inferSelect;
export type LeagueFeatureFlagInsert = typeof leagueFeatureFlag.$inferInsert;
export type NotificationPreferenceRow = typeof notificationPreference.$inferSelect;
export type NotificationPreferenceInsert =
  typeof notificationPreference.$inferInsert;
