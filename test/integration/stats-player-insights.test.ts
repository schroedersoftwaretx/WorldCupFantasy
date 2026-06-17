/**
 * Integration tests for Phase 2 player insights:
 *   - src/data/stats/ownership.ts   (cross-league ownership %)
 *   - src/data/stats/adp.ts         (ADP, take-rate, reach/steal)
 *   - src/data/stats/differentials.ts (per-team differentials / template / value)
 *   - src/data/stats/hub.ts#getDraftTrends (public Draft Trends composition)
 *
 * A multi-league fixture is seeded so ownership % and ADP are checkable against
 * hand-computed values, and so the privacy property (a team's insights only ever
 * list its OWN players) can be asserted directly.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import {
  draftPick,
  draftRoom,
  fantasyTeam,
  fixture,
  league,
  manager,
  nationalTeam,
  player,
  rosterSlot,
  scoreEntry,
  type DraftStatus,
  type LeagueStatus,
  type Position,
} from "../../src/data/db/schema.js";
import {
  globalOwnership,
  ownershipForPlayer,
  ownershipByPlayerId,
} from "../../src/data/stats/ownership.js";
import { globalAdp, adpByPlayerId } from "../../src/data/stats/adp.js";
import { teamInsights } from "../../src/data/stats/differentials.js";
import { getDraftTrends } from "../../src/data/stats/hub.js";
import { setupContainer } from "./setup.js";

const { ctx } = setupContainer();
const RULESET = "test-v1";

async function nt(tag: string): Promise<number> {
  const [r] = await ctx.db
    .insert(nationalTeam)
    .values({ name: `NT-${tag}`, sourceTeamId: `nt-${tag}-${Math.random()}` })
    .returning();
  return r!.id;
}
async function pl(
  teamId: number,
  position: Position,
  name: string,
  draftRank: number | null = null,
): Promise<number> {
  const [r] = await ctx.db
    .insert(player)
    .values({
      fullName: name,
      position,
      nationalTeamId: teamId,
      sourcePlayerId: `p-${name}-${Math.random()}`,
      ...(draftRank !== null ? { draftRank } : {}),
    })
    .returning();
  return r!.id;
}
async function mgr(tag: string): Promise<number> {
  const [r] = await ctx.db
    .insert(manager)
    .values({
      firebaseUid: `uid-${tag}-${Math.random()}`,
      displayName: `Mgr ${tag}`,
      email: `${tag}@example.com`,
    })
    .returning();
  return r!.id;
}
async function lg(name: string, status: LeagueStatus, createdBy: number): Promise<number> {
  const [r] = await ctx.db
    .insert(league)
    .values({
      name,
      createdByManagerId: createdBy,
      scoringRuleset: { version: RULESET },
      status,
    })
    .returning();
  return r!.id;
}
async function team(leagueId: number, managerId: number, name: string): Promise<number> {
  const [r] = await ctx.db
    .insert(fantasyTeam)
    .values({ leagueId, managerId, name })
    .returning();
  return r!.id;
}
async function roster(
  teamId: number,
  leagueId: number,
  playerId: number,
  position: Position,
): Promise<void> {
  await ctx.db
    .insert(rosterSlot)
    .values({ fantasyTeamId: teamId, leagueId, playerId, draftedPosition: position });
}
async function room(leagueId: number, status: DraftStatus): Promise<number> {
  const [r] = await ctx.db
    .insert(draftRoom)
    .values({ leagueId, status, totalPicks: 0 })
    .returning();
  return r!.id;
}
async function pick(
  roomId: number,
  teamId: number,
  playerId: number,
  pickNumber: number,
): Promise<void> {
  await ctx.db.insert(draftPick).values({
    draftRoomId: roomId,
    pickNumber,
    round: 1,
    fantasyTeamId: teamId,
    playerId,
  });
}
async function fx(home: number, away: number): Promise<number> {
  const [r] = await ctx.db
    .insert(fixture)
    .values({
      sourceFixtureId: `f-${Math.random()}`,
      stage: "GROUP_1",
      homeTeamId: home,
      awayTeamId: away,
      kickoffUtc: new Date("2026-06-11T18:00:00Z"),
      status: "FINISHED",
    })
    .returning();
  return r!.id;
}
async function score(playerId: number, fixtureId: number, points: number): Promise<void> {
  await ctx.db
    .insert(scoreEntry)
    .values({ playerId, fixtureId, rulesetVersion: RULESET, points, breakdown: {} });
}

describe("player insights (ownership / adp / differentials)", () => {
  beforeEach(async () => {
    // Full reset incl. the league-side tables resetDb() leaves alone, so the
    // cross-league aggregates start from a known-empty state every test.
    await ctx.db.execute(
      sql`TRUNCATE TABLE manager, league, fantasy_team, league_membership, league_invite, draft_room, draft_order, draft_pick, roster_slot, standings_snapshot, score_entry, stat_line, fixture, player, national_team, notification, league_feature_flag RESTART IDENTITY CASCADE`,
    );
  });

  it("ownership % = distinct teams / total teams, scoped to finished drafts", async () => {
    const t = await nt("A");
    const p1 = await pl(t, "FWD", "P1");
    const p2 = await pl(t, "MID", "P2");
    const p3 = await pl(t, "DEF", "P3");

    // A fantasy_team is unique per (league, manager), so each team needs its
    // own manager within a league.
    const m = await mgr("o");
    const lA = await lg("A", "ACTIVE", m);
    const lB = await lg("B", "ACTIVE", m);
    const lC = await lg("C", "DRAFTING", m);
    const a1 = await team(lA, await mgr("a1"), "A1");
    const a2 = await team(lA, await mgr("a2"), "A2");
    const b1 = await team(lB, await mgr("b1"), "B1");
    const b2 = await team(lB, await mgr("b2"), "B2");
    const c1 = await team(lC, await mgr("c1"), "C1");

    // P1 owned in A (by a1) and B (by b1) -> 2 of 4 finished teams.
    await roster(a1, lA, p1, "FWD");
    await roster(b1, lB, p1, "FWD");
    // P2 owned only by a1 -> 1 of 4.
    await roster(a1, lA, p2, "MID");
    // P3 owned only in the UNFINISHED league C -> 0 of 4 when finished-only.
    await roster(c1, lC, p3, "DEF");
    void a2;
    void b2;

    const res = await globalOwnership(ctx.db);
    expect(res.totalFantasyTeams).toBe(4);
    const byId = new Map(res.players.map((r) => [r.playerId, r]));
    expect(byId.get(p1)!.ownedCount).toBe(2);
    expect(byId.get(p1)!.ownershipPct).toBe(0.5);
    expect(byId.get(p2)!.ownedCount).toBe(1);
    expect(byId.get(p2)!.ownershipPct).toBe(0.25);
    expect(byId.has(p3)).toBe(false); // unfinished league excluded
    // Sorted most-owned first.
    expect(res.players[0]!.playerId).toBe(p1);

    // Single-player + map helpers agree with the list.
    expect(await ownershipForPlayer(ctx.db, p1)).toEqual({
      ownedCount: 2,
      ownershipPct: 0.5,
      totalFantasyTeams: 4,
    });
    const map = await ownershipByPlayerId(ctx.db);
    expect(map.byPlayerId.get(p2)).toEqual({ ownedCount: 1, ownershipPct: 0.25 });

    // Including unfinished drafts widens the denominator and surfaces P3.
    const all = await globalOwnership(ctx.db, { finishedDraftsOnly: false });
    expect(all.totalFantasyTeams).toBe(5);
    const allById = new Map(all.players.map((r) => [r.playerId, r]));
    expect(allById.get(p3)!.ownedCount).toBe(1);
  });

  it("ADP = mean pick number; reach/steal sign is correct", async () => {
    const t = await nt("A");
    const p1 = await pl(t, "FWD", "P1", 5); // ranked 5
    const p2 = await pl(t, "MID", "P2"); // unranked
    const p4 = await pl(t, "DEF", "P4", 1); // ranked 1 (a "stud")

    const m = await mgr("d");
    const lA = await lg("A", "ACTIVE", m);
    const lB = await lg("B", "ACTIVE", m);
    const a1 = await team(lA, m, "A1");
    const b1 = await team(lB, m, "B1");
    const rA = await room(lA, "COMPLETE");
    const rB = await room(lB, "COMPLETE");

    // P1 taken in both drafts: pick 1 and pick 3 -> ADP 2.
    await pick(rA, a1, p1, 1);
    await pick(rB, b1, p1, 3);
    // P2 taken once at pick 2 -> ADP 2, take-rate 1/2.
    await pick(rA, a1, p2, 2);
    // P4 taken once at pick 10 -> ADP 10.
    await pick(rB, b1, p4, 10);

    const res = await globalAdp(ctx.db);
    expect(res.totalDrafts).toBe(2);
    const byId = new Map(res.players.map((r) => [r.playerId, r]));

    expect(byId.get(p1)!.adp).toBe(2);
    expect(byId.get(p1)!.earliestPick).toBe(1);
    expect(byId.get(p1)!.latestPick).toBe(3);
    expect(byId.get(p1)!.timesPicked).toBe(2);
    expect(byId.get(p1)!.takeRate).toBe(1);
    // ADP 2 vs rank 5 -> drafted EARLIER than rank -> negative.
    expect(byId.get(p1)!.reachSteal).toBe(-3);

    expect(byId.get(p2)!.adp).toBe(2);
    expect(byId.get(p2)!.takeRate).toBe(0.5);
    expect(byId.get(p2)!.reachSteal).toBeNull(); // unranked

    // ADP 10 vs rank 1 -> fell well past rank -> positive ("steal").
    expect(byId.get(p4)!.reachSteal).toBe(9);

    // Sorted by ADP ascending (ties broken by playerId): P1(2), P2(2), P4(10).
    expect(res.players.map((r) => r.playerId)).toEqual([p1, p2, p4]);

    const map = await adpByPlayerId(ctx.db);
    expect(map.byPlayerId.get(p1)!.adp).toBe(2);
  });

  it("getDraftTrends merges ADP analytics with ownership %", async () => {
    const t = await nt("A");
    const p1 = await pl(t, "FWD", "P1", 5);
    const m = await mgr("t");
    const lA = await lg("A", "ACTIVE", m);
    const a1 = await team(lA, m, "A1");
    const rA = await room(lA, "COMPLETE");
    await roster(a1, lA, p1, "FWD");
    await pick(rA, a1, p1, 1);

    const trends = await getDraftTrends(ctx.db);
    expect(trends.totalDrafts).toBe(1);
    expect(trends.totalFantasyTeams).toBe(1);
    const row = trends.rows.find((r) => r.playerId === p1)!;
    expect(row.adp).toBe(1);
    expect(row.ownedCount).toBe(1);
    expect(row.ownershipPct).toBe(1);
    expect(row.reachSteal).toBe(-4); // adp 1 - rank 5
  });

  it("team differentials list ONLY the team's own players (privacy)", async () => {
    const t = await nt("A");
    // P1 is a "template" star (high ownership); P2 a low-owned differential.
    const p1 = await pl(t, "FWD", "P1", 2);
    const p2 = await pl(t, "MID", "P2", 40);
    const rivalOnly = await pl(t, "DEF", "Rival"); // only on another league's team

    const m = await mgr("v");
    const lA = await lg("A", "ACTIVE", m);
    const lB = await lg("B", "ACTIVE", m);
    const a1 = await team(lA, m, "A1");
    const b1 = await team(lB, m, "B1");

    // P1 owned in BOTH leagues (2/2 = 100% -> template); P2 only by a1 (1/2 = 50%).
    await roster(a1, lA, p1, "FWD");
    await roster(b1, lB, p1, "FWD");
    await roster(a1, lA, p2, "MID");
    // Rival player belongs to b1 (a different league's team) only.
    await roster(b1, lB, rivalOnly, "DEF");

    // ADP so value (points/ADP) is defined.
    const rA = await room(lA, "COMPLETE");
    await pick(rA, a1, p1, 1);
    await pick(rA, a1, p2, 8);

    // Points for the ruleset.
    const f = await fx(t, t);
    await score(p1, f, 10); // template star also scores
    await score(p2, f, 12); // differential scoring well

    const ins = await teamInsights(ctx.db, {
      leagueId: lA,
      teamId: a1,
      rulesetVersion: RULESET,
      templateThreshold: 0.5,
    });

    // Only a1's two players appear anywhere in the payload.
    const ids = new Set(ins.players.map((p) => p.playerId));
    expect(ids).toEqual(new Set([p1, p2]));
    expect(ins.players.some((p) => p.playerId === rivalOnly)).toBe(false);

    // P2 (50% < ... actually 50% is NOT < 0.5) -> ensure bucket logic:
    // ownership: p1 = 2/2 = 1.0 (>= 0.5 -> template); p2 = 1/2 = 0.5 (>= 0.5 -> template too).
    // So lower the threshold to separate them and re-check.
    const ins2 = await teamInsights(ctx.db, {
      leagueId: lA,
      teamId: a1,
      rulesetVersion: RULESET,
      templateThreshold: 0.75,
    });
    expect(ins2.template.map((p) => p.playerId)).toContain(p1); // 1.0 >= 0.75
    expect(ins2.differentials.map((p) => p.playerId)).toContain(p2); // 0.5 < 0.75, 12 pts

    // Value = points / ADP: p2 = 12/8 = 1.5, p1 = 10/1 = 10 -> p1 best value.
    expect(ins2.bestValue[0]!.playerId).toBe(p1);
    const p2row = ins2.players.find((p) => p.playerId === p2)!;
    expect(p2row.valuePerAdp).toBe(1.5);
    expect(p2row.ownershipPct).toBe(0.5);
  });

  it("teamInsights rejects a team that is not in the league", async () => {
    const m = await mgr("x");
    const lA = await lg("A", "ACTIVE", m);
    const lB = await lg("B", "ACTIVE", m);
    const a1 = await team(lA, m, "A1");
    await expect(
      teamInsights(ctx.db, { leagueId: lB, teamId: a1, rulesetVersion: RULESET }),
    ).rejects.toThrow();
  });
});
