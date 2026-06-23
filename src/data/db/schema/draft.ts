/**
 * World Cup Fantasy - draft domain tables.
 *
 * Phase 4 (draft): draft_room, draft_order, draft_pick, draft_notification.
 * Phase 8:         draft_queue.
 *
 * Invariants worth remembering:
 *   - A league has at most one draft_room.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import {
  draftNotificationTypeEnum,
  draftStatusEnum,
  notificationStatusEnum,
} from "./enums.js";
import { player } from "./football.js";
import { fantasyTeam, league, manager } from "./leagues.js";

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

// --- Type helpers ------------------------------------------------------------

export type DraftRoomRow = typeof draftRoom.$inferSelect;
export type DraftRoomInsert = typeof draftRoom.$inferInsert;
export type DraftOrderRow = typeof draftOrder.$inferSelect;
export type DraftOrderInsert = typeof draftOrder.$inferInsert;
export type DraftPickRow = typeof draftPick.$inferSelect;
export type DraftPickInsert = typeof draftPick.$inferInsert;
export type DraftNotificationRow = typeof draftNotification.$inferSelect;
export type DraftNotificationInsert = typeof draftNotification.$inferInsert;
export type DraftQueueRow = typeof draftQueue.$inferSelect;
export type DraftQueueInsert = typeof draftQueue.$inferInsert;
