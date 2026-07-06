/**
 * World Cup Fantasy - social domain tables (Phase 3 subset: chat).
 *
 * Per-league chat with emoji reactions, gated by the `chat` feature flag.
 *
 * Invariants worth remembering:
 *   - Messages are SOFT-deleted (deleted_at) so the thread keeps its shape;
 *     the service redacts the body of deleted rows on read.
 *   - chat_reaction is unique per (message, manager, emoji) - the PK - and
 *     toggling re-posts/removes that row.
 *   - Realtime is the Phase 0 SSE poll helper over the list read; no
 *     websocket machinery.
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
} from "drizzle-orm/pg-core";

import { league, manager } from "./leagues.js";

// --- chat_message -------------------------------------------------------------

export const chatMessage = pgTable(
  "chat_message",
  {
    id: serial("id").primaryKey(),
    leagueId: integer("league_id")
      .notNull()
      .references(() => league.id, { onDelete: "restrict" }),
    managerId: integer("manager_id")
      .notNull()
      .references(() => manager.id, { onDelete: "restrict" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    leagueCreatedIdx: index("chat_message_league_id_created_at_idx").on(
      t.leagueId,
      t.createdAt,
    ),
  }),
);

// --- chat_reaction --------------------------------------------------------------

export const chatReaction = pgTable(
  "chat_reaction",
  {
    messageId: integer("message_id")
      .notNull()
      .references(() => chatMessage.id, { onDelete: "restrict" }),
    managerId: integer("manager_id")
      .notNull()
      .references(() => manager.id, { onDelete: "restrict" }),
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.messageId, t.managerId, t.emoji] }),
  }),
);

// --- Type helpers ------------------------------------------------------------------

export type ChatMessageRow = typeof chatMessage.$inferSelect;
export type ChatMessageInsert = typeof chatMessage.$inferInsert;
export type ChatReactionRow = typeof chatReaction.$inferSelect;
export type ChatReactionInsert = typeof chatReaction.$inferInsert;
