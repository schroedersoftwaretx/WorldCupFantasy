/**
 * Integration tests for Phase 5 standings.
 *
 * Builds two leagues' worth of real rosters + score_entry rows and checks
 * that computeStandings reads them correctly: per-period best-ball totals,
 * cumulative ranking, and the section 5.3 Final-match tie-breaker.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  fixture,
  nationalTeam,
  player,
  scoreEntry,
  type Position,
} from "../../src/data/db/schema.js";
import {
  acceptInvite,
  createLeague,
  createManager,
  inviteManager,
} from "../../src/data/league/service.js";
import { addPlayerToRoster } from "../../src/data/roster/service.js";
import { DEFAULT_RULESET } from "../../src/data/scoring/ruleset.js";
import { computeStandings } from "../../src/data/standings/standings.js";
import { setupContainer } from "./setup.js";

const { ctx } = setupContainer();
const RULESET = DEFAULT_RULESET.version;

async function seedNationalTeam(tag: string): Promise<number> {
  const [row] = await ctx.db
    .insert(nationalTeam)
    .values({ name: `NT-${tag}`, sourceTeamId: `nt-${tag}-${Math.random()}` })
    .returning();
  if (!row) throw new Error("national team seed failed");
  return row.id;
}

/** Seed a pool of players keyed by position. */
async function seedPool(nationalTeamId: number): Promise<Record<Position, number[]>> {
  const spec: Array<[Position, number]> = [
    ["GK", 6],
    ["DEF", 18],
    ["MID", 18],
    ["FWD", 12],
  ];
  const out: Record<Position, number[]> = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const [position, n] of spec) {
    for (let i = 0; i < n; i += 1) {
      const [row] = await ctx.db
        .insert(player)
        .values({
          fullName: `${position}-${i}`,
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

/** Build a legal 2 GK / 8 DEF / 8 MID / 5 FWD roster (minimums first). */
async function buildRoster(
  teamId: number,
  pick: { GK: number[]; DEF: number[]; MID: number[]; FWD: number[] },
): Promise<void> {
  const order = [
    ...pick.GK.slice(0, 2),
    ...pick.DEF.slice(0, 6),
    ...pick.MID.slice(0, 5),
    ...pick.FWD.slice(0, 4),
    ...pick.DEF.slice(6, 8),
    ...pick.MID.slice(5, 8),
    ...pick.FWD.slice(4, 5),
  ];
  for (const playerId of order) {
    await addPlayerToRoster(ctx.db, { fantasyTeamId: teamId, playerId });
  }
}

async function seedFixture(
  sourceId: string,
  stage: "GROUP_1" | "FINAL",
  homeTeamId: number,
  awayTeamId: number,
): Promise<number> {
  const [row] = await ctx.db
    .insert(fixture)
    .values({
      sourceFixtureId: sourceId,
      stage,
      homeTeamId,
      awayTeamId,
      kickoffUtc: new Date("2026-06-11T18:00:00Z"),
      status: "FINISHED",
    })
    .returning();
  if (!row) throw new Error("fixture seed failed");
  return row.id;
}

async function giveScore(
  playerId: number,
  fixtureId: number,
  points: number,
): Promise<void> {
  await ctx.db.insert(scoreEntry).values({
    playerId,
    fixtureId,
    rulesetVersion: RULESET,
    points,
    breakdown: {},
  });
}

interface Built {
  leagueId: number;
  teamA: number;
  teamB: number;
  poolA: Record<Position, number[]>;
  poolB: Record<Position, number[]>;
}

/** Two managers, one league, two full legal rosters from disjoint pools. */
async function buildLeague(): Promise<Built> {
  const ntA = await seedNationalTeam("A");
  const ntB = await seedNationalTeam("B");
  const poolA = await seedPool(ntA);
  const poolB = await seedPool(ntB);

  const owner = await createManager(ctx.db, {
    firebaseUid: `o-${Math.random()}`,
    displayName: "Owner",
    email: `o-${Math.random()}@x.com`,
  });
  const created = await createLeague(ctx.db, {
    ownerManagerId: owner.id,
    name: "Standings League",
  });
  const joiner = await createManager(ctx.db, {
    firebaseUid: `j-${Math.random()}`,
    displayName: "Joiner",
    email: `j-${Math.random()}@x.com`,
  });
  const invite = await inviteManager(ctx.db, { leagueId: created.league.id });
  const joined = await acceptInvite(ctx.db, {
    token: invite.token,
    managerId: joiner.id,
  });

  await buildRoster(created.ownerTeam.id, poolA);
  await buildRoster(joined.team.id, poolB);

  return {
    leagueId: created.league.id,
    teamA: created.ownerTeam.id,
    teamB: joined.team.id,
    poolA,
    poolB,
  };
}

describe("Phase 5 standings (integration)", () => {
  beforeEach(async () => {
    await ctx.resetDb();
  });

  it("ranks teams by cumulative best-ball total", async () => {
    const { leagueId, teamA, teamB, poolA } = await buildLeague();
    const fx = await seedFixture("g1", "GROUP_1", 1, 2);

    // Team A: an 11-player 5-3-2 set, 10 points each -> best-ball 110.
    const aXi = [
      ...poolA.GK.slice(0, 1),
      ...poolA.DEF.slice(0, 5),
      ...poolA.MID.slice(0, 3),
      ...poolA.FWD.slice(0, 2),
    ];
    for (const pid of aXi) await giveScore(pid, fx, 10);
    // Team B scores nothing.

    const standings = await computeStandings(ctx.db, leagueId);
    expect(standings.map((s) => s.fantasyTeamId)).toEqual([teamA, teamB]);
    expect(standings[0]?.total).toBe(110);
    expect(standings[0]?.rank).toBe(1);
    expect(standings[1]?.total).toBe(0);
    expect(standings[1]?.rank).toBe(2);
  });

  it("exposes the per-period optimal XI and formation", async () => {
    const { leagueId, teamA, poolA } = await buildLeague();
    const fx = await seedFixture("g1", "GROUP_1", 1, 2);
    const aXi = [
      ...poolA.GK.slice(0, 1),
      ...poolA.DEF.slice(0, 5),
      ...poolA.MID.slice(0, 3),
      ...poolA.FWD.slice(0, 2),
    ];
    for (const pid of aXi) await giveScore(pid, fx, 10);

    const standings = await computeStandings(ctx.db, leagueId);
    const entryA = standings.find((s) => s.fantasyTeamId === teamA);
    const g1 = entryA?.periods.find((p) => p.stage === "GROUP_1");
    expect(g1?.formation).toBe("5-3-2"); // 5 DEF carry, only 2 FWD scored
    expect(g1?.points).toBe(110);
    expect(g1?.xi).toHaveLength(11);
    // A period with no scores stays empty.
    const r16 = entryA?.periods.find((p) => p.stage === "R16");
    expect(r16?.points).toBe(0);
  });

  it("breaks an equal total by Final-match points (section 5.3 #2)", async () => {
    const { leagueId, teamA, teamB, poolA, poolB } = await buildLeague();
    const g1 = await seedFixture("g1", "GROUP_1", 1, 2);
    const final = await seedFixture("final", "FINAL", 1, 2);

    // Team A: GROUP_1 best-ball 110, nothing in the Final. Total 110.
    const aXi = [
      ...poolA.GK.slice(0, 1),
      ...poolA.DEF.slice(0, 5),
      ...poolA.MID.slice(0, 3),
      ...poolA.FWD.slice(0, 2),
    ];
    for (const pid of aXi) await giveScore(pid, g1, 10);

    // Team B: GROUP_1 best-ball 80 (eight players x 10), and in the Final
    // all FIVE rostered FWDs score 10. Best-ball can only field 3 FWD, so
    // the Final period contributes 30 -> total 80 + 30 = 110 (a tie with A),
    // but finalMatchPoints counts all five = 50.
    const bG1 = [
      ...poolB.GK.slice(0, 1),
      ...poolB.DEF.slice(0, 4),
      ...poolB.MID.slice(0, 2),
      ...poolB.FWD.slice(0, 1),
    ];
    for (const pid of bG1) await giveScore(pid, g1, 10);
    for (const pid of poolB.FWD.slice(0, 5)) await giveScore(pid, final, 10);

    const standings = await computeStandings(ctx.db, leagueId);
    // Both totals are 110...
    expect(standings[0]?.total).toBe(110);
    expect(standings[1]?.total).toBe(110);
    // ...so the Final-match tie-breaker decides: B (50) ahead of A (0).
    expect(standings[0]?.fantasyTeamId).toBe(teamB);
    expect(standings[0]?.tieBreakers.finalMatchPoints).toBe(50);
    expect(standings[1]?.fantasyTeamId).toBe(teamA);
    expect(standings[1]?.tieBreakers.finalMatchPoints).toBe(0);
  });
});
