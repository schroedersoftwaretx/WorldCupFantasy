/**
 * Integration tests for the Phase 8 draft pick-queue + queue-aware autopick.
 *
 * Exercises the real DB end to end: queue CRUD (add/remove/reorder), and the
 * load-bearing behaviour that an expired pick autopicks the team's QUEUED
 * player when it is still available and legal, and falls back to draft_rank
 * when the queue is empty.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";

import {
  draftPick,
  draftRoom,
  nationalTeam,
  player,
  type Position,
} from "../../src/data/db/schema.js";
import {
  createLeague,
  createManager,
  acceptInvite,
  inviteManager,
} from "../../src/data/league/service.js";
import {
  createDraftRoom,
  processExpiredPicks,
  startDraft,
} from "../../src/data/draft/service.js";
import {
  addToQueue,
  getQueue,
  queuedPlayerIds,
  removeFromQueue,
  reorderQueue,
} from "../../src/data/draft/queue.js";
import { setupContainer } from "./setup.js";

const { ctx } = setupContainer();

async function seedNationalTeam(): Promise<number> {
  const [row] = await ctx.db
    .insert(nationalTeam)
    .values({ name: "Testland", sourceTeamId: `nt-${Date.now()}-${Math.random()}` })
    .returning();
  if (!row) throw new Error("national team seed failed");
  return row.id;
}

async function seedPlayers(nationalTeamId: number): Promise<Record<Position, number[]>> {
  const spec: Array<[Position, number]> = [
    ["GK", 15],
    ["DEF", 30],
    ["MID", 30],
    ["FWD", 30],
  ];
  const out: Record<Position, number[]> = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const [position, n] of spec) {
    for (let i = 0; i < n; i += 1) {
      const [row] = await ctx.db
        .insert(player)
        .values({
          fullName: `${position} ${i}`,
          position,
          nationalTeamId,
          sourcePlayerId: `p-${position}-${i}-${Math.random()}`,
        })
        .returning();
      if (row) out[position].push(row.id);
    }
  }
  return out;
}

async function seedLeague(n: number): Promise<{ leagueId: number; teamIds: number[] }> {
  const owner = await createManager(ctx.db, {
    firebaseUid: `owner-${Math.random()}`,
    displayName: "Owner",
    email: `owner-${Math.random()}@example.com`,
  });
  const created = await createLeague(ctx.db, {
    ownerManagerId: owner.id,
    name: "Queue League",
    maxManagers: 24,
  });
  const teamIds = [created.ownerTeam.id];
  for (let i = 1; i < n; i += 1) {
    const m = await createManager(ctx.db, {
      firebaseUid: `joiner-${i}-${Math.random()}`,
      displayName: `Joiner ${i}`,
      email: `joiner-${i}-${Math.random()}@example.com`,
    });
    const invite = await inviteManager(ctx.db, { leagueId: created.league.id });
    const joined = await acceptInvite(ctx.db, { token: invite.token, managerId: m.id });
    teamIds.push(joined.team.id);
  }
  return { leagueId: created.league.id, teamIds };
}

async function setRank(playerId: number, rank: number): Promise<void> {
  await ctx.db.update(player).set({ draftRank: rank }).where(eq(player.id, playerId));
}

async function expireDeadline(draftRoomId: number): Promise<void> {
  await ctx.db
    .update(draftRoom)
    .set({ currentPickDeadline: new Date(Date.now() - 60_000) })
    .where(eq(draftRoom.id, draftRoomId));
}

async function firstPickPlayerId(draftRoomId: number): Promise<number> {
  const rows = await ctx.db
    .select({ playerId: draftPick.playerId })
    .from(draftPick)
    .where(eq(draftPick.draftRoomId, draftRoomId))
    .orderBy(asc(draftPick.pickNumber));
  return rows[0]!.playerId;
}

describe("draft pick-queue (integration)", () => {
  beforeEach(async () => {
    await ctx.resetDb();
  });

  it("add / reorder / remove keep ranks contiguous and ordered", async () => {
    const nt = await seedNationalTeam();
    const pool = await seedPlayers(nt);
    const { leagueId, teamIds } = await seedLeague(2);
    const room = await createDraftRoom(ctx.db, { leagueId, pickTimerHours: 12 });
    await startDraft(ctx.db, { draftRoomId: room.id, order: teamIds });
    const team = teamIds[0]!;

    const [a, b, c] = [pool.FWD[0]!, pool.MID[0]!, pool.DEF[0]!];
    await addToQueue(ctx.db, room.id, team, a, leagueId);
    await addToQueue(ctx.db, room.id, team, b, leagueId);
    await addToQueue(ctx.db, room.id, team, c, leagueId);
    // Adding a duplicate is a no-op.
    await addToQueue(ctx.db, room.id, team, a, leagueId);

    expect(await queuedPlayerIds(ctx.db, room.id, team)).toEqual([a, b, c]);

    // Reorder: c first.
    await reorderQueue(ctx.db, room.id, team, [c, a, b], leagueId);
    expect(await queuedPlayerIds(ctx.db, room.id, team)).toEqual([c, a, b]);

    // Remove the middle and re-pack.
    const after = await removeFromQueue(ctx.db, room.id, team, a, leagueId);
    expect(after.map((e) => e.playerId)).toEqual([c, b]);
    expect(after.map((e) => e.rank)).toEqual([1, 2]);
  });

  it("queue is per-team: one team's queue does not leak into another's", async () => {
    const nt = await seedNationalTeam();
    const pool = await seedPlayers(nt);
    const { leagueId, teamIds } = await seedLeague(2);
    const room = await createDraftRoom(ctx.db, { leagueId, pickTimerHours: 12 });
    await startDraft(ctx.db, { draftRoomId: room.id, order: teamIds });

    await addToQueue(ctx.db, room.id, teamIds[0]!, pool.FWD[0]!, leagueId);
    expect(await queuedPlayerIds(ctx.db, room.id, teamIds[1]!)).toEqual([]);
  });

  it("autopick takes the QUEUED player over the better draft_rank player", async () => {
    const nt = await seedNationalTeam();
    const pool = await seedPlayers(nt);
    const { leagueId, teamIds } = await seedLeague(3);
    const room = await createDraftRoom(ctx.db, { leagueId, pickTimerHours: 12 });
    await startDraft(ctx.db, { draftRoomId: room.id, order: teamIds });

    const best = pool.FWD[0]!; // rank 1 — what draft_rank would take
    const wanted = pool.MID[5]!; // worse rank, but queued
    await setRank(best, 1);
    await setRank(wanted, 50);
    await addToQueue(ctx.db, room.id, teamIds[0]!, wanted, leagueId);

    await expireDeadline(room.id);
    const ticked = await processExpiredPicks(ctx.db, { draftRoomId: room.id });
    expect(ticked.autopicks).toBeGreaterThanOrEqual(1);

    // Pick 1 (team 0, who had the queue) is the queued player, not the rank-1.
    expect(await firstPickPlayerId(room.id)).toBe(wanted);
  });

  it("falls back to draft_rank when the queue is empty", async () => {
    const nt = await seedNationalTeam();
    const pool = await seedPlayers(nt);
    const { leagueId, teamIds } = await seedLeague(3);
    const room = await createDraftRoom(ctx.db, { leagueId, pickTimerHours: 12 });
    await startDraft(ctx.db, { draftRoomId: room.id, order: teamIds });

    const best = pool.FWD[0]!;
    await setRank(best, 1);
    // No queue for team 0.

    await expireDeadline(room.id);
    await processExpiredPicks(ctx.db, { draftRoomId: room.id });
    expect(await firstPickPlayerId(room.id)).toBe(best);
  });

  it("getQueue flags a queued player as unavailable once drafted", async () => {
    const nt = await seedNationalTeam();
    const pool = await seedPlayers(nt);
    const { leagueId, teamIds } = await seedLeague(3);
    const room = await createDraftRoom(ctx.db, { leagueId, pickTimerHours: 12 });
    await startDraft(ctx.db, { draftRoomId: room.id, order: teamIds });

    const target = pool.FWD[0]!;
    await setRank(target, 1);
    // Team 1 queues the same player team 0 will auto-take.
    await addToQueue(ctx.db, room.id, teamIds[1]!, target, leagueId);

    await expireDeadline(room.id);
    await processExpiredPicks(ctx.db, { draftRoomId: room.id });

    const q = await getQueue(ctx.db, room.id, teamIds[1]!, leagueId);
    const entry = q.find((e) => e.playerId === target);
    expect(entry?.available).toBe(false);
  });
});
