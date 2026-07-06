/**
 * Integration tests for league chat (Phase 3 subset): flag/membership
 * gates, post/list/edit/delete/react, pagination, and burst-deduped +
 * mutable notifications through the Phase 0 hub.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { notification } from "../../src/data/db/schema.js";
import { setFlag } from "../../src/data/league/feature-flags.js";
import {
  acceptInvite,
  createLeague,
  createManager,
  inviteManager,
} from "../../src/data/league/service.js";
import { setPreference } from "../../src/data/notify/preferences.js";
import {
  deleteMessage,
  editMessage,
  listMessages,
  postMessage,
  toggleReaction,
} from "../../src/data/social/chat.js";
import { setupContainer } from "./setup.js";

const { ctx } = setupContainer();

interface Built {
  leagueId: number;
  ownerId: number;
  memberId: number;
}

async function buildLeague(chatOn = true): Promise<Built> {
  const owner = await createManager(ctx.db, {
    firebaseUid: `o-${Math.random()}`,
    displayName: "Olive Owner",
    email: `o-${Math.random()}@x.com`,
  });
  const created = await createLeague(ctx.db, {
    ownerManagerId: owner.id,
    name: "Chat League",
  });
  const joiner = await createManager(ctx.db, {
    firebaseUid: `j-${Math.random()}`,
    displayName: "Mia Member",
    email: `j-${Math.random()}@x.com`,
  });
  const invite = await inviteManager(ctx.db, { leagueId: created.league.id });
  await acceptInvite(ctx.db, { token: invite.token, managerId: joiner.id });
  if (chatOn) {
    await setFlag(ctx.db, created.league.id, "chat", { enabled: true });
  }
  return { leagueId: created.league.id, ownerId: owner.id, memberId: joiner.id };
}

async function inAppChatNotifications(managerId: number) {
  return ctx.db
    .select()
    .from(notification)
    .where(
      and(eq(notification.managerId, managerId), eq(notification.type, "CHAT_MESSAGE")),
    );
}

describe("league chat (integration)", () => {
  beforeEach(async () => {
    await ctx.resetDb();
  });

  it("gates posting on the chat flag and membership", async () => {
    const { leagueId, ownerId } = await buildLeague(false);
    await expect(
      postMessage(ctx.db, { leagueId, managerId: ownerId, body: "hello" }),
    ).rejects.toMatchObject({ code: "CHAT_FLAG_DISABLED" });

    await setFlag(ctx.db, leagueId, "chat", { enabled: true });
    const outsider = await createManager(ctx.db, {
      firebaseUid: `x-${Math.random()}`,
      displayName: "Outsider",
      email: `x-${Math.random()}@x.com`,
    });
    await expect(
      postMessage(ctx.db, { leagueId, managerId: outsider.id, body: "hi" }),
    ).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    await expect(
      listMessages(ctx.db, { leagueId, managerId: outsider.id }),
    ).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
  });

  it("posts, lists newest-first with reactions, and paginates", async () => {
    const { leagueId, ownerId, memberId } = await buildLeague();
    const m1 = await postMessage(ctx.db, { leagueId, managerId: ownerId, body: "first" });
    await postMessage(ctx.db, { leagueId, managerId: memberId, body: "second" });
    const m3 = await postMessage(ctx.db, { leagueId, managerId: ownerId, body: "third" });

    await toggleReaction(ctx.db, {
      leagueId,
      messageId: m1.id,
      managerId: memberId,
      emoji: "\u{1F44D}",
    });
    await toggleReaction(ctx.db, {
      leagueId,
      messageId: m1.id,
      managerId: ownerId,
      emoji: "\u{1F44D}",
    });

    const page = await listMessages(ctx.db, { leagueId, managerId: ownerId });
    expect(page.map((m) => m.body)).toEqual(["third", "second", "first"]);
    expect(page[0]?.authorName).toBe("Olive Owner");
    const first = page[2];
    expect(first?.reactions).toEqual([
      {
        emoji: "\u{1F44D}",
        count: 2,
        managerIds: [ownerId, memberId].sort((a, b) => a - b),
      },
    ]);

    // Toggle off removes the reaction.
    await toggleReaction(ctx.db, {
      leagueId,
      messageId: m1.id,
      managerId: ownerId,
      emoji: "\u{1F44D}",
    });
    const after = await listMessages(ctx.db, { leagueId, managerId: ownerId });
    expect(after[2]?.reactions[0]?.count).toBe(1);

    // Pagination: everything strictly older than m3.
    const older = await listMessages(ctx.db, {
      leagueId,
      managerId: ownerId,
      beforeId: m3.id,
    });
    expect(older.map((m) => m.body)).toEqual(["second", "first"]);
  });

  it("edits only your own; deletes by author or owner; redacts deleted", async () => {
    const { leagueId, ownerId, memberId } = await buildLeague();
    const msg = await postMessage(ctx.db, {
      leagueId,
      managerId: memberId,
      body: "typo",
    });

    await expect(
      editMessage(ctx.db, { leagueId, messageId: msg.id, managerId: ownerId, body: "x" }),
    ).rejects.toMatchObject({ code: "NOT_YOUR_MESSAGE" });

    const edited = await editMessage(ctx.db, {
      leagueId,
      messageId: msg.id,
      managerId: memberId,
      body: "fixed",
    });
    expect(edited.body).toBe("fixed");
    expect(edited.editedAt).not.toBeNull();

    // Owner moderation delete.
    await deleteMessage(ctx.db, { leagueId, messageId: msg.id, managerId: ownerId });
    const page = await listMessages(ctx.db, { leagueId, managerId: ownerId });
    expect(page[0]).toMatchObject({ body: "[deleted]", deleted: true });

    // Deleted messages cannot be edited or reacted to.
    await expect(
      editMessage(ctx.db, { leagueId, messageId: msg.id, managerId: memberId, body: "z" }),
    ).rejects.toMatchObject({ code: "MESSAGE_NOT_FOUND" });
    await expect(
      toggleReaction(ctx.db, {
        leagueId,
        messageId: msg.id,
        managerId: memberId,
        emoji: "\u{1F44D}",
      }),
    ).rejects.toMatchObject({ code: "MESSAGE_NOT_FOUND" });
  });

  it("notifies other members once per burst window, and respects mute", async () => {
    const { leagueId, ownerId, memberId } = await buildLeague();
    const t0 = new Date("2026-06-01T12:00:00Z");

    await postMessage(ctx.db, { leagueId, managerId: ownerId, body: "one", now: t0 });
    await postMessage(ctx.db, {
      leagueId,
      managerId: ownerId,
      body: "two",
      now: new Date(t0.getTime() + 60_000),
    });

    // Burst: two posts in one window -> exactly one notification for the
    // other member, none for the author.
    expect(await inAppChatNotifications(memberId)).toHaveLength(1);
    expect(await inAppChatNotifications(ownerId)).toHaveLength(0);

    // Next window -> one more.
    await postMessage(ctx.db, {
      leagueId,
      managerId: ownerId,
      body: "three",
      now: new Date(t0.getTime() + 11 * 60_000),
    });
    expect(await inAppChatNotifications(memberId)).toHaveLength(2);

    // Muted member gets nothing new.
    await setPreference(ctx.db, memberId, "CHAT_MESSAGE", "IN_APP", false);
    await postMessage(ctx.db, {
      leagueId,
      managerId: ownerId,
      body: "four",
      now: new Date(t0.getTime() + 22 * 60_000),
    });
    expect(await inAppChatNotifications(memberId)).toHaveLength(2);
  });
});
