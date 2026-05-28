/**
 * Integration tests for the Phase 4 async snake draft.
 *
 * Exercises the real DB end to end: snake turn-order enforcement, the
 * 12-hour timer + constraint-aware autopick on expiry, the durable
 * notification queue, and full-draft completion advancing the league to
 * ACTIVE with every roster provably legal.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import {
  draftNotification,
  draftPick,
  draftRoom,
  league,
  nationalTeam,
  player,
  type Position,
} from "../../src/data/db/schema.js";
import { DraftError } from "../../src/data/league/errors.js";
import {
  createLeague,
  createManager,
  acceptInvite,
  inviteManager,
} from "../../src/data/league/service.js";
import {
  createDraftRoom,
  getDraftState,
  makePick,
  processExpiredPicks,
  startDraft,
} from "../../src/data/draft/service.js";
import { RecordingNotifier } from "../../src/data/draft/notifier.js";
import { validateRoster } from "../../src/data/roster/service.js";
import { setupContainer } from "./setup.js";

const { ctx } = setupContainer();

/** Insert a national team to hang synthetic players off. */
async function seedNationalTeam(): Promise<number> {
  const [row] = await ctx.db
    .insert(nationalTeam)
    .values({ name: "Testland", sourceTeamId: `nt-${Date.now()}-${Math.random()}` })
    .returning();
  if (!row) throw new Error("national team seed failed");
  return row.id;
}

/**
 * Seed a generous player pool: enough of every position that a 3-team,
 * 69-pick draft always completes. Returns ids grouped by position.
 */
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

/** Create a league with `n` managers; returns league id + team ids in join order. */
async function seedLeague(n: number): Promise<{ leagueId: number; teamIds: number[] }> {
  const owner = await createManager(ctx.db, {
    firebaseUid: `owner-${Math.random()}`,
    displayName: "Owner",
    email: `owner-${Math.random()}@example.com`,
  });
  const created = await createLeague(ctx.db, {
    ownerManagerId: owner.id,
    name: "Draft League",
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

/** Force the on-the-clock pick's deadline into the past. */
async function expireDeadline(draftRoomId: number): Promise<void> {
  await ctx.db
    .update(draftRoom)
    .set({ currentPickDeadline: new Date(Date.now() - 60_000) })
    .where(eq(draftRoom.id, draftRoomId));
}

describe("Phase 4 async snake draft (integration)", () => {
  beforeEach(async () => {
    await ctx.resetDb();
  });

  it("enforces snake turn order; out-of-turn picks are rejected", async () => {
    const nt = await seedNationalTeam();
    const pool = await seedPlayers(nt);
    const { leagueId, teamIds } = await seedLeague(3);
    const [t1, t2, t3] = teamIds as [number, number, number];

    const room = await createDraftRoom(ctx.db, { leagueId, pickTimerHours: 12 });
    await startDraft(ctx.db, { draftRoomId: room.id, order: [t1, t2, t3] });

    // Pick 1 belongs to t1. t2 cannot jump the queue.
    await expect(
      makePick(ctx.db, {
        draftRoomId: room.id,
        fantasyTeamId: t2,
        playerId: pool.FWD[0] as number,
      }),
    ).rejects.toBeInstanceOf(DraftError);

    // Picks 1, 2, 3 go to t1, t2, t3 in order.
    await makePick(ctx.db, { draftRoomId: room.id, fantasyTeamId: t1, playerId: pool.FWD[0] as number });
    await makePick(ctx.db, { draftRoomId: room.id, fantasyTeamId: t2, playerId: pool.FWD[1] as number });
    await makePick(ctx.db, { draftRoomId: room.id, fantasyTeamId: t3, playerId: pool.FWD[2] as number });

    // Pick 4 is round 2 - the snake reverses, so t3 picks again.
    const state = await getDraftState(ctx.db, room.id);
    expect(state.onClock?.pickNumber).toBe(4);
    expect(state.onClock?.round).toBe(2);
    expect(state.onClock?.fantasyTeamId).toBe(t3);

    await expect(
      makePick(ctx.db, {
        draftRoomId: room.id,
        fantasyTeamId: t1,
        playerId: pool.FWD[3] as number,
      }),
    ).rejects.toBeInstanceOf(DraftError);
  });

  it("autopicks the on-the-clock team when the deadline lapses", async () => {
    const nt = await seedNationalTeam();
    await seedPlayers(nt);
    const { leagueId, teamIds } = await seedLeague(3);
    const room = await createDraftRoom(ctx.db, { leagueId, pickTimerHours: 12 });
    await startDraft(ctx.db, {
      draftRoomId: room.id,
      order: teamIds,
    });

    // Nothing expired yet -> tick is a no-op.
    const noop = await processExpiredPicks(ctx.db, { draftRoomId: room.id });
    expect(noop.autopicks).toBe(0);

    // Expire pick 1, then tick: exactly one autopick (timer 12h -> the next
    // pick gets a fresh future deadline).
    await expireDeadline(room.id);
    const ticked = await processExpiredPicks(ctx.db, { draftRoomId: room.id });
    expect(ticked.autopicks).toBe(1);

    const picks = await ctx.db
      .select()
      .from(draftPick)
      .where(eq(draftPick.draftRoomId, room.id));
    expect(picks).toHaveLength(1);
    expect(picks[0]?.isAutopick).toBe(true);
    expect(picks[0]?.pickNumber).toBe(1);

    // The draft has advanced to pick 2 with a fresh future deadline.
    const state = await getDraftState(ctx.db, room.id);
    expect(state.onClock?.pickNumber).toBe(2);
  });

  it("autopick takes the best-ranked legal player", async () => {
    const nt = await seedNationalTeam();
    const pool = await seedPlayers(nt);
    const { leagueId, teamIds } = await seedLeague(3);

    // Make one specific MID the clear #1 board pick.
    const topPick = pool.MID[7] as number;
    await ctx.db.update(player).set({ draftRank: 1 }).where(eq(player.id, topPick));
    // Give a few others worse ranks so "best legal" is unambiguous.
    await ctx.db.update(player).set({ draftRank: 50 }).where(eq(player.id, pool.FWD[0] as number));

    const room = await createDraftRoom(ctx.db, { leagueId, pickTimerHours: 12 });
    await startDraft(ctx.db, { draftRoomId: room.id, order: teamIds });

    await expireDeadline(room.id);
    await processExpiredPicks(ctx.db, { draftRoomId: room.id });

    const [pick] = await ctx.db
      .select()
      .from(draftPick)
      .where(and(eq(draftPick.draftRoomId, room.id), eq(draftPick.pickNumber, 1)));
    expect(pick?.playerId).toBe(topPick);
  });

  it("records notifications durably and delivers them via the notifier", async () => {
    const nt = await seedNationalTeam();
    await seedPlayers(nt);
    const { leagueId, teamIds } = await seedLeague(3);
    const notifier = new RecordingNotifier();

    const room = await createDraftRoom(ctx.db, { leagueId, pickTimerHours: 12 });
    await startDraft(ctx.db, { draftRoomId: room.id, order: teamIds, notifier });

    // Every manager got DRAFT_STARTED; pick 1's manager got ON_THE_CLOCK.
    expect(notifier.ofType("DRAFT_STARTED")).toHaveLength(3);
    expect(notifier.ofType("ON_THE_CLOCK")).toHaveLength(1);

    // The durable rows exist and are marked SENT.
    const rows = await ctx.db
      .select()
      .from(draftNotification)
      .where(eq(draftNotification.draftRoomId, room.id));
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.status === "SENT")).toBe(true);
  });

  it("a failed delivery stays retryable and succeeds on the next attempt", async () => {
    const nt = await seedNationalTeam();
    await seedPlayers(nt);
    const { leagueId, teamIds } = await seedLeague(3);

    const room = await createDraftRoom(ctx.db, { leagueId, pickTimerHours: 12 });
    // Notifier that fails: the rows are written but not delivered.
    const failing = new RecordingNotifier(true);
    await startDraft(ctx.db, { draftRoomId: room.id, order: teamIds, notifier: failing });

    let rows = await ctx.db
      .select()
      .from(draftNotification)
      .where(eq(draftNotification.draftRoomId, room.id));
    expect(rows.every((r) => r.status === "FAILED")).toBe(true);

    // A later tick with a working notifier retries the FAILED rows.
    const working = new RecordingNotifier();
    await processExpiredPicks(ctx.db, { draftRoomId: room.id, notifier: working });
    rows = await ctx.db
      .select()
      .from(draftNotification)
      .where(eq(draftNotification.draftRoomId, room.id));
    expect(rows.every((r) => r.status === "SENT")).toBe(true);
  });

  it("a full draft completes: every roster is legal and the league goes ACTIVE", async () => {
    const nt = await seedNationalTeam();
    await seedPlayers(nt);
    const { leagueId, teamIds } = await seedLeague(3);

    // pickTimerHours 0 -> every pick is immediately expired, so one tick
    // drains the whole 69-pick draft via autopick.
    const room = await createDraftRoom(ctx.db, { leagueId, pickTimerHours: 0 });
    await startDraft(ctx.db, { draftRoomId: room.id, order: teamIds });

    const result = await processExpiredPicks(ctx.db, { draftRoomId: room.id });
    expect(result.autopicks).toBe(69); // 3 teams * 23

    const [done] = await ctx.db
      .select()
      .from(draftRoom)
      .where(eq(draftRoom.id, room.id));
    expect(done?.status).toBe("COMPLETE");

    const [lg] = await ctx.db.select().from(league).where(eq(league.id, leagueId));
    expect(lg?.status).toBe("ACTIVE");

    // Every team holds a provably legal 23-man roster.
    for (const teamId of teamIds) {
      const validation = await validateRoster(ctx.db, teamId);
      expect(validation.ok).toBe(true);
    }

    // A second tick on a COMPLETE draft is a no-op.
    const again = await processExpiredPicks(ctx.db, { draftRoomId: room.id });
    expect(again.autopicks).toBe(0);
  });
});
