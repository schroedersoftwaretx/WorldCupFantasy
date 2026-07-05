/**
 * Integration tests for head-to-head (Phase 9 Priority 2): flag gate,
 * schedule generation over the seeded WC periods, derived results/table
 * from real standings totals, and the regeneration lock.
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import {
  fixture,
  nationalTeam,
  player,
  scoreEntry,
  type Position,
  type Stage,
} from "../../src/data/db/schema.js";
import { computeH2h } from "../../src/data/h2h/results.js";
import { generateSchedule, getSchedule } from "../../src/data/h2h/schedule.js";
import { setFlag } from "../../src/data/league/feature-flags.js";
import {
  acceptInvite,
  createLeague,
  createManager,
  inviteManager,
} from "../../src/data/league/service.js";
import { addPlayerToRoster } from "../../src/data/roster/service.js";
import { DEFAULT_RULESET } from "../../src/data/scoring/ruleset.js";
import { setupContainer } from "./setup.js";

const { ctx } = setupContainer();
const RULESET = DEFAULT_RULESET.version;

async function worldCupCompetitionId(): Promise<number> {
  const res = await ctx.db.execute(
    sql`SELECT id FROM competition WHERE name = 'FIFA World Cup' AND season_label = '2026'`,
  );
  const id = (res.rows[0] as { id: number } | undefined)?.id;
  if (!id) throw new Error("World Cup competition not seeded by 0012");
  return id;
}

async function seedNationalTeam(tag: string): Promise<number> {
  const [row] = await ctx.db
    .insert(nationalTeam)
    .values({ name: `NT-${tag}`, sourceTeamId: `nt-${tag}-${Math.random()}` })
    .returning();
  if (!row) throw new Error("national team seed failed");
  return row.id;
}

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
  stage: Stage,
  homeTeamId: number,
  awayTeamId: number,
  status: "SCHEDULED" | "FINISHED",
): Promise<number> {
  const compId = await worldCupCompetitionId();
  const res = await ctx.db.execute(
    sql`SELECT id FROM scoring_period WHERE competition_id = ${compId} AND stage_code = ${stage}`,
  );
  const periodId = (res.rows[0] as { id: number } | undefined)?.id ?? null;
  const [row] = await ctx.db
    .insert(fixture)
    .values({
      sourceFixtureId: `fx-${Math.random()}`,
      stage,
      scoringPeriodId: periodId,
      homeTeamId,
      awayTeamId,
      kickoffUtc: new Date("2026-06-11T18:00:00Z"),
      status,
    })
    .returning();
  if (!row) throw new Error("fixture seed failed");
  return row.id;
}

async function giveScore(playerId: number, fixtureId: number, points: number): Promise<void> {
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
  ntA: number;
  ntB: number;
}

/** Best-ball league (2 teams) pointed at the seeded WC competition. */
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
    name: "H2H League",
  });
  const joiner = await createManager(ctx.db, {
    firebaseUid: `j-${Math.random()}`,
    displayName: "Joiner",
    email: `j-${Math.random()}@x.com`,
  });
  const invite = await inviteManager(ctx.db, { leagueId: created.league.id });
  const joined = await acceptInvite(ctx.db, { token: invite.token, managerId: joiner.id });
  await buildRoster(created.ownerTeam.id, poolA);
  await buildRoster(joined.team.id, poolB);
  const compId = await worldCupCompetitionId();
  await ctx.db.execute(
    sql`UPDATE league SET competition_id = ${compId} WHERE id = ${created.league.id}`,
  );
  return {
    leagueId: created.league.id,
    teamA: created.ownerTeam.id,
    teamB: joined.team.id,
    poolA,
    poolB,
    ntA,
    ntB,
  };
}

describe("head-to-head (integration)", () => {
  beforeEach(async () => {
    await ctx.resetDb();
  });

  it("refuses to generate without the flag, then generates a full schedule", async () => {
    const { leagueId, teamA, teamB } = await buildLeague();

    await expect(generateSchedule(ctx.db, leagueId)).rejects.toMatchObject({
      code: "H2H_FLAG_DISABLED",
    });

    await setFlag(ctx.db, leagueId, "head_to_head", {
      enabled: true,
      config: { primaryStandings: false },
    });
    const result = await generateSchedule(ctx.db, leagueId);
    // Two teams meet in every one of the nine WC periods.
    expect(result).toMatchObject({ periods: 9, matchups: 9, regenerated: false });

    const rows = await getSchedule(ctx.db, leagueId);
    expect(rows).toHaveLength(9);
    for (const m of rows) {
      expect([m.homeFantasyTeamId, m.awayFantasyTeamId].sort((a, b) => a - b)).toEqual(
        [teamA, teamB].sort((a, b) => a - b),
      );
    }
  });

  it("derives results, table and rivalries from period totals", async () => {
    const { leagueId, teamA, teamB, poolA, poolB, ntA, ntB } = await buildLeague();
    await setFlag(ctx.db, leagueId, "head_to_head", { enabled: true });
    await generateSchedule(ctx.db, leagueId);

    // GROUP_1 finalized: A out-scores B. GROUP_2 not finished yet.
    const fx1 = await seedFixture("GROUP_1", ntA, ntB, "FINISHED");
    await seedFixture("GROUP_2", ntB, ntA, "SCHEDULED");
    const aXi = [
      ...poolA.GK.slice(0, 1),
      ...poolA.DEF.slice(0, 5),
      ...poolA.MID.slice(0, 3),
      ...poolA.FWD.slice(0, 2),
    ];
    const bXi = [
      ...poolB.GK.slice(0, 1),
      ...poolB.DEF.slice(0, 5),
      ...poolB.MID.slice(0, 3),
      ...poolB.FWD.slice(0, 2),
    ];
    for (const pid of aXi) await giveScore(pid, fx1, 10); // A: 110
    for (const pid of bXi) await giveScore(pid, fx1, 5); // B: 55

    const view = await computeH2h(ctx.db, leagueId);

    const r1 = view.results.find((r) => r.ordinal === 1);
    expect(r1?.finalized).toBe(true);
    const aIsHome = r1?.homeFantasyTeamId === teamA;
    expect(aIsHome ? r1?.homePoints : r1?.awayPoints).toBe(110);
    expect(aIsHome ? r1?.awayPoints : r1?.homePoints).toBe(55);
    expect(r1?.outcome).toBe(aIsHome ? "HOME" : "AWAY");

    const r2 = view.results.find((r) => r.ordinal === 2);
    expect(r2?.finalized).toBe(false);
    expect(r2?.outcome).toBeNull();

    expect(view.table[0]).toMatchObject({
      fantasyTeamId: teamA,
      wins: 1,
      played: 1,
      h2hPoints: 3,
      rank: 1,
    });
    expect(view.table[1]).toMatchObject({ fantasyTeamId: teamB, losses: 1, rank: 2 });

    expect(view.rivalries).toHaveLength(1);
    const riv = view.rivalries[0];
    const aFirst = riv?.teamAId === teamA;
    expect(aFirst ? riv?.aWins : riv?.bWins).toBe(1);
    expect(riv?.draws).toBe(0);
  });

  it("allows regeneration until a scheduled period finalizes, then locks", async () => {
    const { leagueId, ntA, ntB } = await buildLeague();
    await setFlag(ctx.db, leagueId, "head_to_head", { enabled: true });
    await generateSchedule(ctx.db, leagueId);

    // Nothing finished yet -> regeneration allowed.
    await seedFixture("GROUP_1", ntA, ntB, "SCHEDULED");
    const regen = await generateSchedule(ctx.db, leagueId);
    expect(regen.regenerated).toBe(true);

    // First period finalizes -> locked.
    await seedFixture("GROUP_1", ntB, ntA, "FINISHED");
    await ctx.db.execute(sql`UPDATE fixture SET status = 'FINISHED'`);
    await expect(generateSchedule(ctx.db, leagueId)).rejects.toMatchObject({
      code: "H2H_SCHEDULE_LOCKED",
    });
  });

  it("requires a competition (matchups key on scoring_period rows)", async () => {
    const { leagueId } = await buildLeague();
    await setFlag(ctx.db, leagueId, "head_to_head", { enabled: true });
    await ctx.db.execute(sql`UPDATE league SET competition_id = NULL WHERE id = ${leagueId}`);
    await expect(generateSchedule(ctx.db, leagueId)).rejects.toMatchObject({
      code: "H2H_REQUIRES_COMPETITION",
    });
  });
});
