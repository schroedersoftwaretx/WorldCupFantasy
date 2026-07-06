/**
 * League chat service (Phase 3 subset, built under Phase 9 Priority 4).
 *
 * Post / edit / soft-delete / list / react, all membership-gated and behind
 * the `chat` feature flag. New messages fan out IN_APP notifications to the
 * other members through the Phase 0 hub, deduped per 10-minute burst window
 * so an active conversation produces at most one notification per member
 * per league per window; the CHAT_MESSAGE preference category is the
 * per-member mute switch (handled inside enqueue via allowedChannels).
 *
 * Pure service: takes a Db and plain inputs; no HTTP/auth/env here.
 */
import { and, desc, eq, inArray, lt } from "drizzle-orm";

import type { Db } from "../db/client.js";
import {
  chatMessage,
  chatReaction,
  league,
  leagueMembership,
  manager,
  type ChatMessageRow,
} from "../db/schema.js";
import { isFlagEnabled } from "../league/feature-flags.js";
import { enqueue } from "../notify/service.js";

export class ChatError extends Error {
  constructor(
    message: string,
    /** Stable machine-readable code, e.g. "CHAT_FLAG_DISABLED". */
    public readonly code: string,
  ) {
    super(message);
    this.name = "ChatError";
  }
}

export const MAX_BODY_LENGTH = 2000;
/** Burst window for chat notifications (one per member/league/window). */
export const NOTIFY_BURST_MS = 10 * 60 * 1000;

/** Membership + flag gate shared by every entry point. */
async function requireChatMember(
  db: Db,
  leagueId: number,
  managerId: number,
): Promise<{ role: "OWNER" | "MEMBER" }> {
  const [lg] = await db.select().from(league).where(eq(league.id, leagueId));
  if (!lg) throw new ChatError(`league ${leagueId} does not exist`, "LEAGUE_NOT_FOUND");
  if (!(await isFlagEnabled(db, leagueId, "chat"))) {
    throw new ChatError(
      `league ${leagueId} does not have the chat flag enabled`,
      "CHAT_FLAG_DISABLED",
    );
  }
  const [membership] = await db
    .select()
    .from(leagueMembership)
    .where(
      and(
        eq(leagueMembership.leagueId, leagueId),
        eq(leagueMembership.managerId, managerId),
      ),
    );
  if (!membership) {
    throw new ChatError(
      `manager ${managerId} is not a member of league ${leagueId}`,
      "NOT_A_MEMBER",
    );
  }
  return { role: membership.role };
}

export interface PostMessageInput {
  leagueId: number;
  managerId: number;
  body: string;
  /** Injectable clock for tests. */
  now?: Date;
}

/** Post a message and fan out burst-deduped notifications to other members. */
export async function postMessage(
  db: Db,
  input: PostMessageInput,
): Promise<ChatMessageRow> {
  await requireChatMember(db, input.leagueId, input.managerId);
  const body = input.body.trim();
  if (body.length === 0) {
    throw new ChatError("message body must not be empty", "EMPTY_BODY");
  }
  if (body.length > MAX_BODY_LENGTH) {
    throw new ChatError(
      `message body must be at most ${MAX_BODY_LENGTH} characters`,
      "BODY_TOO_LONG",
    );
  }
  const now = input.now ?? new Date();

  const [row] = await db
    .insert(chatMessage)
    .values({
      leagueId: input.leagueId,
      managerId: input.managerId,
      body,
      createdAt: now,
    })
    .returning();
  if (!row) throw new ChatError("message insert failed", "MESSAGE_INSERT_FAILED");

  // Fan out to the other members. Burst dedupe: one notification per
  // (league, recipient, 10-minute bucket) via the hub's dedupeKey.
  const [lg] = await db.select().from(league).where(eq(league.id, input.leagueId));
  const [author] = await db
    .select()
    .from(manager)
    .where(eq(manager.id, input.managerId));
  const members = await db
    .select()
    .from(leagueMembership)
    .where(eq(leagueMembership.leagueId, input.leagueId));
  const bucket = Math.floor(now.getTime() / NOTIFY_BURST_MS);
  for (const m of members) {
    if (m.managerId === input.managerId) continue;
    await enqueue(db, {
      managerId: m.managerId,
      type: "CHAT_MESSAGE",
      title: `New chat in ${lg?.name ?? "your league"}`,
      body: `${author?.displayName ?? "Someone"}: ${body.slice(0, 120)}`,
      leagueId: input.leagueId,
      link: `/leagues/${input.leagueId}/chat`,
      channels: ["IN_APP"],
      dedupeKey: `chat:${input.leagueId}:${m.managerId}:${bucket}`,
    });
  }
  return row;
}

export interface EditMessageInput {
  leagueId: number;
  messageId: number;
  managerId: number;
  body: string;
  now?: Date;
}

/** Edit your own (not-deleted) message. */
export async function editMessage(
  db: Db,
  input: EditMessageInput,
): Promise<ChatMessageRow> {
  await requireChatMember(db, input.leagueId, input.managerId);
  const [msg] = await db
    .select()
    .from(chatMessage)
    .where(
      and(eq(chatMessage.id, input.messageId), eq(chatMessage.leagueId, input.leagueId)),
    );
  if (!msg || msg.deletedAt !== null) {
    throw new ChatError(`message ${input.messageId} not found`, "MESSAGE_NOT_FOUND");
  }
  if (msg.managerId !== input.managerId) {
    throw new ChatError("you can only edit your own messages", "NOT_YOUR_MESSAGE");
  }
  const body = input.body.trim();
  if (body.length === 0) throw new ChatError("message body must not be empty", "EMPTY_BODY");
  if (body.length > MAX_BODY_LENGTH) {
    throw new ChatError(
      `message body must be at most ${MAX_BODY_LENGTH} characters`,
      "BODY_TOO_LONG",
    );
  }
  const [updated] = await db
    .update(chatMessage)
    .set({ body, editedAt: input.now ?? new Date() })
    .where(eq(chatMessage.id, msg.id))
    .returning();
  if (!updated) throw new ChatError("message update failed", "MESSAGE_UPDATE_FAILED");
  return updated;
}

export interface DeleteMessageInput {
  leagueId: number;
  messageId: number;
  managerId: number;
  now?: Date;
}

/** Soft-delete: authors may delete their own; the league OWNER may delete any. */
export async function deleteMessage(
  db: Db,
  input: DeleteMessageInput,
): Promise<void> {
  const { role } = await requireChatMember(db, input.leagueId, input.managerId);
  const [msg] = await db
    .select()
    .from(chatMessage)
    .where(
      and(eq(chatMessage.id, input.messageId), eq(chatMessage.leagueId, input.leagueId)),
    );
  if (!msg || msg.deletedAt !== null) {
    throw new ChatError(`message ${input.messageId} not found`, "MESSAGE_NOT_FOUND");
  }
  if (msg.managerId !== input.managerId && role !== "OWNER") {
    throw new ChatError(
      "only the author or the league owner can delete a message",
      "NOT_YOUR_MESSAGE",
    );
  }
  await db
    .update(chatMessage)
    .set({ deletedAt: input.now ?? new Date() })
    .where(eq(chatMessage.id, msg.id));
}

export interface ToggleReactionInput {
  leagueId: number;
  messageId: number;
  managerId: number;
  emoji: string;
}

/** Toggle one emoji reaction on a message. Returns true when now present. */
export async function toggleReaction(
  db: Db,
  input: ToggleReactionInput,
): Promise<boolean> {
  await requireChatMember(db, input.leagueId, input.managerId);
  const emoji = input.emoji.trim();
  if (emoji.length === 0 || emoji.length > 16) {
    throw new ChatError("emoji must be 1-16 characters", "INVALID_EMOJI");
  }
  const [msg] = await db
    .select()
    .from(chatMessage)
    .where(
      and(eq(chatMessage.id, input.messageId), eq(chatMessage.leagueId, input.leagueId)),
    );
  if (!msg || msg.deletedAt !== null) {
    throw new ChatError(`message ${input.messageId} not found`, "MESSAGE_NOT_FOUND");
  }
  const [existing] = await db
    .select()
    .from(chatReaction)
    .where(
      and(
        eq(chatReaction.messageId, input.messageId),
        eq(chatReaction.managerId, input.managerId),
        eq(chatReaction.emoji, emoji),
      ),
    );
  if (existing) {
    await db
      .delete(chatReaction)
      .where(
        and(
          eq(chatReaction.messageId, input.messageId),
          eq(chatReaction.managerId, input.managerId),
          eq(chatReaction.emoji, emoji),
        ),
      );
    return false;
  }
  await db.insert(chatReaction).values({
    messageId: input.messageId,
    managerId: input.managerId,
    emoji,
  });
  return true;
}

export interface ChatReactionView {
  emoji: string;
  count: number;
  /** Manager ids who reacted (for "did I react?" in the UI). */
  managerIds: number[];
}

export interface ChatMessageView {
  id: number;
  managerId: number;
  authorName: string;
  /** "[deleted]" for soft-deleted rows. */
  body: string;
  deleted: boolean;
  createdAt: Date;
  editedAt: Date | null;
  reactions: ChatReactionView[];
}

export interface ListMessagesInput {
  leagueId: number;
  managerId: number;
  /** Return messages with id < beforeId (older page). */
  beforeId?: number;
  /** Default 50, max 100. */
  limit?: number;
}

/** Newest-first page of messages with reactions and author names. */
export async function listMessages(
  db: Db,
  input: ListMessagesInput,
): Promise<ChatMessageView[]> {
  await requireChatMember(db, input.leagueId, input.managerId);
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);

  const conditions = [eq(chatMessage.leagueId, input.leagueId)];
  if (input.beforeId !== undefined) {
    conditions.push(lt(chatMessage.id, input.beforeId));
  }
  const rows = await db
    .select({
      id: chatMessage.id,
      managerId: chatMessage.managerId,
      body: chatMessage.body,
      createdAt: chatMessage.createdAt,
      editedAt: chatMessage.editedAt,
      deletedAt: chatMessage.deletedAt,
      authorName: manager.displayName,
    })
    .from(chatMessage)
    .innerJoin(manager, eq(manager.id, chatMessage.managerId))
    .where(and(...conditions))
    .orderBy(desc(chatMessage.id))
    .limit(limit);

  const ids = rows.map((r) => r.id);
  const reactions =
    ids.length > 0
      ? await db.select().from(chatReaction).where(inArray(chatReaction.messageId, ids))
      : [];
  const byMessage = new Map<number, Map<string, number[]>>();
  for (const r of reactions) {
    const emojis = byMessage.get(r.messageId) ?? new Map<string, number[]>();
    const list = emojis.get(r.emoji) ?? [];
    list.push(r.managerId);
    emojis.set(r.emoji, list);
    byMessage.set(r.messageId, emojis);
  }

  return rows.map((r) => ({
    id: r.id,
    managerId: r.managerId,
    authorName: r.authorName,
    body: r.deletedAt !== null ? "[deleted]" : r.body,
    deleted: r.deletedAt !== null,
    createdAt: r.createdAt,
    editedAt: r.editedAt,
    reactions: [...(byMessage.get(r.id) ?? new Map<string, number[]>())]
      .map(([emoji, managerIds]) => ({
        emoji,
        count: managerIds.length,
        managerIds: [...managerIds].sort((a, b) => a - b),
      }))
      .sort((a, b) => a.emoji.localeCompare(b.emoji)),
  }));
}
