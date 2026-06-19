/**
 * Integration tests for Phase 7.1 tournament awards (DERIVED only):
 *   - src/data/awards/registry.ts
 *
 * A single small league is seeded with three full (11-player, 5-3-2) legal
 * squads so best-ball period points are forced and hand-computable. Each
 * award's ranking is then asserted against values worked out by hand:
 *
 *   Raw stat_line (per team):
 *     goals   T1=3  T2=2  T3=1     (Golden Boot)
 *     assists T1=1  T2=2  T3=3     (Playmaker)
 *     saves   T1=5  T2=8  T3=2     (Golden Glove, keepers only)
 *
 *   score_entry (ruleset "test-v1"), one scorer per team, one fixture/stage:
 *     fwd1  G1=10 G2=10  -> T1 stage pts [10,10] total 20
 *     fwd2  G1=20        -> T2 stage pts [20, 0] total 20
 *     fwd3  G1= 6 G2= 8  -> T3 stage pts [ 6, 8] total 14
 *
 *   => highest-single-stage  T2(20) T1(10) T3(8)
 *   => best-single-xi        T2/G1=20, then the two 10s share rank 2, ...
 *   => most-consistent (var) T1(0) T3(1) T2(100)
 *   => biggest-haul          T2(20) T1(10) T3(8)
 *   => best-draft-value      T1 20/1=20, T2 20/2=10, T3 14/3=4.67
 *   => best-differential     T1(20) & T2(20) tie, T3(14)  (all 1/3 owned)
 *
 *   Global (player-attributed, ruleset "test-v1"):
 *     golden-boot  fwd1(3) fwd2(2) fwd3(1)
 *     playmaker    fwd3(3) fwd2(2) fwd1(1)
 *     golden-glove gk2(8)  gk1(5)  gk3(2)
 *     biggest-haul fwd2(20) fwd1(10) fwd1(10) fwd3(8) fwd3(6)
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
  statLine,
  type Position,
  type Stage,
} from "../../src/data/db/schema.js";
import {
  computeGlobalAwards,
  computeTrophyRoom,
  type AwardResult,
} from "../../src/data/awards/registry.js";
import { setupContainer } from "./setup.js";

const { ctx } = setupContainer();
const RULESET = "test-v1";
const LEAGUE_AWARD_COUNT = 9;

// --- seed helpers ------------------------------------------------------------

async function nt(tag: string): Promise<number> {
  const [r] = await ctx.db
    .insert(nationalTeam)
    .values({ name: `NT-${tag}`, sourceTeamId: `nt-${tag}-${Math.random()}` })
    .returning();
  return r!.id;
}
async function pl(teamId: number, position: Position, name: string): Promise<number> {
  const [r] = await ctx.db
    .insert(player)
    .values({
      fullName: name,
      position,
      nationalTeamId: teamId,
      sourcePlayerId: `p-${name}-${Math.random()}`,
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
async function lg(name: string, createdBy: number): Promise<number> {
  const [r] = await ctx.db
    .insert(league)
    .values({
      name,
      createdByManagerId: createdBy,
      scoringRuleset: { version: RULESET },
      status: "ACTIVE",
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
async function fx(home: number, away: number, stage: Stage): Promise<number> {
  const [r] = await ctx.db
    .insert(fixture)
    .values({
      sourceFixtureId: `f-${Math.random()}`,
      stage,
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
async function stat(
  playerId: number,
  fixtureId: number,
  values: { goals?: number; assists?: number; saves?: number },
): Promise<void> {
  await ctx.db.insert(statLine).values({
    playerId,
    fixtureId,
    goals: values.goals ?? 0,
    assists: values.assists ?? 0,
    saves: values.saves ?? 0,
    sourceRevision: "test",
  });
}
async function room(leagueId: number): Promise<number> {
  const [r] = await ctx.db
    .insert(draftRoom)
    .values({ leagueId, status: "COMPLETE", totalPicks: 0 })
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

/** A full legal 5-3-2 squad (1 GK, 5 DEF, 3 MID, 2 FWD). Returns the GK and
 * the first FWD (the team's "scorer"); the other 9 are scoreless filler. */
async function squad(
  ntId: number,
  leagueId: number,
  teamId: number,
  tag: string,
): Promise<{ gk: number; fwd: number }> {
  const gk = await pl(ntId, "GK", `${tag}-GK`);
  await roster(teamId, leagueId, gk, "GK");
  for (let i = 0; i < 5; i += 1) {
    const d = await pl(ntId, "DEF", `${tag}-DEF${i}`);
    await roster(teamId, leagueId, d, "DEF");
  }
  for (let i = 0; i < 3; i += 1) {
    const m = await pl(ntId, "MID", `${tag}-MID${i}`);
    await roster(teamId, leagueId, m, "MID");
  }
  const fwd = await pl(ntId, "FWD", `${tag}-FWD0`);
  await roster(teamId, leagueId, fwd, "FWD");
  const fwd2 = await pl(ntId, "FWD", `${tag}-FWD1`);
  await roster(teamId, leagueId, fwd2, "FWD");
  return { gk, fwd };
}

function byId(results: AwardResult[], id: string): AwardResult {
  const r = results.find((x) => x.id === id);
  if (!r) throw new Error(`award ${id} not in results`);
  return r;
}

interface World {
  leagueId: number;
  t1: number;
  t2: number;
  t3: number;
  fwd1: number;
  fwd2: number;
  fwd3: number;
  gk1: number;
  gk2: number;
  gk3: number;
}

/** Seed the full coherent world described in the file header. */
async function seedWorld(): Promise<World> {
  const ntA = await nt("A");
  const ntB = await nt("B");
  const f1 = await fx(ntA, ntB, "GROUP_1");
  const f2 = await fx(ntA, ntB, "GROUP_2");

  const owner = await mgr("owner");
  const leagueId = await lg("L", owner);
  const t1 = await team(leagueId, await mgr("m1"), "T1");
  const t2 = await team(leagueId, await mgr("m2"), "T2");
  const t3 = await team(leagueId, await mgr("m3"), "T3");

  const s1 = await squad(ntA, leagueId, t1, "T1");
  const s2 = await squad(ntA, leagueId, t2, "T2");
  const s3 = await squad(ntA, leagueId, t3, "T3");

  // Raw stats (Golden Boot / Playmaker / Golden Glove).
  await stat(s1.fwd, f1, { goals: 3, assists: 1 });
  await stat(s2.fwd, f1, { goals: 2, assists: 2 });
  await stat(s3.fwd, f1, { goals: 1, assists: 3 });
  await stat(s1.gk, f1, { saves: 5 });
  await stat(s2.gk, f1, { saves: 8 });
  await stat(s3.gk, f1, { saves: 2 });

  // Fantasy points (standings / hauls / value / differentials).
  await score(s1.fwd, f1, 10);
  await score(s1.fwd, f2, 10);
  await score(s2.fwd, f1, 20);
  await score(s3.fwd, f1, 6);
  await score(s3.fwd, f2, 8);

  // Draft picks for ADP (best-draft-value).
  const r = await room(leagueId);
  await pick(r, t1, s1.fwd, 1);
  await pick(r, t2, s2.fwd, 2);
  await pick(r, t3, s3.fwd, 3);

  return {
    leagueId,
    t1,
    t2,
    t3,
    fwd1: s1.fwd,
    fwd2: s2.fwd,
    fwd3: s3.fwd,
    gk1: s1.gk,
    gk2: s2.gk,
    gk3: s3.gk,
  };
}

// --- tests -------------------------------------------------------------------

describe("tournament awards registry (derived)", () => {
  beforeEach(async () => {
    await ctx.db.execute(
      sql`TRUNCATE TABLE manager, league, fantasy_team, league_membership, league_invite, draft_room, draft_order, draft_pick, roster_slot, standings_snapshot, score_entry, stat_line, fixture, player, national_team, notification, league_feature_flag RESTART IDENTITY CASCADE`,
    );
  });

  it("player awards rank teams by their rostered players' raw stats", async () => {
    const w = await seedWorld();
    const trophy = await computeTrophyRoom(ctx.db, {
      leagueId: w.leagueId,
      rulesetVersion: RULESET,
    });

    const boot = byId(trophy, "golden-boot").entries;
    expect(boot.map((e) => [e.fantasyTeamId, e.value])).toEqual([
      [w.t1, 3],
      [w.t2, 2],
      [w.t3, 1],
    ]);

    const playmaker = byId(trophy, "playmaker").entries;
    expect(playmaker.map((e) => [e.fantasyTeamId, e.value])).toEqual([
      [w.t3, 3],
      [w.t2, 2],
      [w.t1, 1],
    ]);

    // Golden Glove counts keepers only (the outfield scorers' 0 saves excluded).
    const glove = byId(trophy, "golden-glove").entries;
    expect(glove.map((e) => [e.fantasyTeamId, e.value])).toEqual([
      [w.t2, 8],
      [w.t1, 5],
      [w.t3, 2],
    ]);
  });

  it("manager awards derive from per-stage best-ball standings", async () => {
    const w = await seedWorld();
    const trophy = await computeTrophyRoom(ctx.db, {
      leagueId: w.leagueId,
      rulesetVersion: RULESET,
    });

    const stage = byId(trophy, "highest-single-stage").entries;
    expect(stage.map((e) => [e.fantasyTeamId, e.value])).toEqual([
      [w.t2, 20],
      [w.t1, 10],
      [w.t3, 8],
    ]);

    // Best single XI: every scoring (team, stage) lineup, the two 10s tie.
    const xi = byId(trophy, "best-single-xi").entries;
    expect(xi[0]!.fantasyTeamId).toBe(w.t2);
    expect(xi[0]!.value).toBe(20);
    expect(xi[0]!.lineup!.length).toBe(11); // forced 5-3-2 XI surfaced
    const tens = xi.filter((e) => e.value === 10);
    expect(tens.length).toBe(2);
    expect(new Set(tens.map((e) => e.rank))).toEqual(new Set([2])); // shared rank
    expect(xi.length).toBe(5);

    // Most consistent = lowest variance of per-stage points across scored stages.
    const consistent = byId(trophy, "most-consistent").entries;
    expect(consistent.map((e) => [e.fantasyTeamId, e.value])).toEqual([
      [w.t1, 0],
      [w.t3, 1],
      [w.t2, 100],
    ]);
  });

  it("biggest haul, draft value and differential awards", async () => {
    const w = await seedWorld();
    const trophy = await computeTrophyRoom(ctx.db, {
      leagueId: w.leagueId,
      rulesetVersion: RULESET,
    });

    const haul = byId(trophy, "best-haul").entries;
    expect(haul.map((e) => [e.fantasyTeamId, e.value])).toEqual([
      [w.t2, 20],
      [w.t1, 10],
      [w.t3, 8],
    ]);
    expect(haul[0]!.playerId).toBe(w.fwd2);

    const value = byId(trophy, "best-draft-value").entries;
    expect(value.map((e) => [e.fantasyTeamId, e.value])).toEqual([
      [w.t1, 20],
      [w.t2, 10],
      [w.t3, 4.67],
    ]);
    expect(value[0]!.playerId).toBe(w.fwd1);

    // All players are 1/3 owned (< 50%) so each team's top scorer is a
    // differential; T1 & T2 tie at 20 and share rank 1, T3 trails at 14.
    const diff = byId(trophy, "best-differential-haul").entries;
    const top = diff.filter((e) => e.value === 20);
    expect(new Set(top.map((e) => e.fantasyTeamId))).toEqual(new Set([w.t1, w.t2]));
    expect(new Set(top.map((e) => e.rank))).toEqual(new Set([1]));
    const last = diff.find((e) => e.fantasyTeamId === w.t3)!;
    expect(last.value).toBe(14);
    expect(last.rank).toBe(3);
  });

  it("global awards are player-attributed and tournament-wide", async () => {
    const w = await seedWorld();
    const global = await computeGlobalAwards(ctx.db, { rulesetVersion: RULESET });

    expect(byId(global, "golden-boot").entries.map((e) => [e.playerId, e.value])).toEqual([
      [w.fwd1, 3],
      [w.fwd2, 2],
      [w.fwd3, 1],
    ]);
    expect(byId(global, "playmaker").entries.map((e) => [e.playerId, e.value])).toEqual([
      [w.fwd3, 3],
      [w.fwd2, 2],
      [w.fwd1, 1],
    ]);
    expect(byId(global, "golden-glove").entries.map((e) => [e.playerId, e.value])).toEqual([
      [w.gk2, 8],
      [w.gk1, 5],
      [w.gk3, 2],
    ]);

    const haul = byId(global, "best-haul").entries;
    expect(haul[0]).toMatchObject({ playerId: w.fwd2, value: 20, rank: 1 });
    expect(haul.map((e) => e.value)).toEqual([20, 10, 10, 8, 6]);
    expect(haul.every((e) => e.fantasyTeamId === null)).toBe(true);
  });

  it("returns empty leaderboards for a league with no data", async () => {
    const owner = await mgr("e");
    const leagueId = await lg("Empty", owner);
    const trophy = await computeTrophyRoom(ctx.db, { leagueId, rulesetVersion: RULESET });
    expect(trophy.length).toBe(LEAGUE_AWARD_COUNT);
    expect(trophy.every((a) => a.entries.length === 0)).toBe(true);
  });
});
