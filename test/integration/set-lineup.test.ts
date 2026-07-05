/**
 * Integration tests for the SET_LINEUP format (Phase 9 Priority 1):
 * league creation guard, submission + lock, captain/vice scoring through
 * computeStandings, roll-forward, and - critically - proof that a
 * best-ball league is completely unaffected by lineup rows.
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import {
  fixture,
  lineup,
  nationalTeam,
  player,
  scoreEntry,
  statLine,
  type Position,
  type Stage,
} from "../../src/data/db/schema.js";
import { LineupError } from "../../src/data/lineup/errors.js";
import { submitLineup } from "../../src/data/lineup/service.js";
import {
  acceptInvite,
  createLeague,
  createManager,
  inviteManager,
} from "../../src/data/league/service.js";
import { LeagueError } from "../../src/data/league/errors.js";
import { addPlayerToRoster } from "../../src/data/roster/service.js";
import { DEFAULT_RULESET } from "../../src/data/scoring/ruleset.js";
import { computeStandings } from "../../src/data/standings/standings.js";
import { setupContainer } from "./setup.js";

const { ctx } = setupContainer();
const RULESET = DEFAULT_RULESET.version;

/** Clock safely before every seeded kickoff (2026-06-11). */
const BEFORE_LOCK = new Date("2026-06-01T00:00:00Z");
const AFTER_LOCK = new Date("2026-06-11T19:00:00Z");

async function worldCupCompetitionId(): Promise<number> {
  const res = await ctx.db.execute(
    sql`SELECT id FROM competition WHERE name = 'FIFA World Cup' AND season_label = '2026'`,
  );
  const id = (res.rows[0] as { id: number } | undefined)?.id;
  if (!id) throw new Error("World Cup competition not seeded by 0012");
  return id;
}

async function periodIdByStage(compId: number, stage: Stage): Promise<number> {
  const res = await ctx.db.execute(
    sql`SELECT id FROM scoring_period WHERE competition_id = ${compId} AND stage_code = ${stage}`,
  );
  const id = (res.rows[0] as { id: number } | undefined)?.id;
  if (!id) throw new Error(`no period for ${stage}`);
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
  sourceId: string,
  stage: Stage,
  homeTeamId: number,
  awayTeamId: number,
  scoringPeriodId: number | null,
): Promise<number> {
  const [row] = await ctx.db
    .insert(fixture)
    .values({
      sourceFixtureId: `${sourceId}-${Math.random()}`,
      stage,
      scoringPeriodId,
      homeTeamId,
      awayTeamId,
      kickoffUtc: new Date("2026-06-11T18:00:00Z"),
      status: "FINISHED",
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

async function giveMinutes(playerId: number, fixtureId: number, minutes: number): Promise<void> {
  await ctx.db.insert(statLine).values({
    playerId,
    fixtureId,
    minutesPlayed: minutes,
    sourceRevision: "test",
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

async function buildLeague(format: "BEST_BALL" | "SET_LINEUP", compId = 0): Promise<Built> {
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
    name: `${format} League`,
    ...(format === "SET_LINEUP"
      ? { format: format as "SET_LINEUP", competitionId: compId }
      : {}),
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
    ntA,
    ntB,
  };
}

/** A legal 4-3-3 XI from a pool. */
function xi433(pool: Record<Position, number[]>): number[] {
  return [
    ...pool.GK.slice(0, 1),
    ...pool.DEF.slice(0, 4),
    ...pool.MID.slice(0, 3),
    ...pool.FWD.slice(0, 3),
  ];
}

describe("SET_LINEUP format (integration)", () => {
  beforeEach(async () => {
    await ctx.resetDb();
  });

  it("requires a competition with periods to create a SET_LINEUP league", async () => {
    const owner = await createManager(ctx.db, {
      firebaseUid: `o-${Math.random()}`,
      displayName: "O",
      email: `o-${Math.random()}@x.com`,
    });
    await expect(
      createLeague(ctx.db, {
        ownerManagerId: owner.id,
        name: "No comp",
        format: "SET_LINEUP",
      }),
    ).rejects.toThrowError(LeagueError);
  });

  it("submits, replaces, locks, and rejects illegal lineups", async () => {
    const compId = await worldCupCompetitionId();
    const { teamA, poolA, ntA, ntB } = await buildLeague("SET_LINEUP", compId);
    const g1 = await periodIdByStage(compId, "GROUP_1");
    await seedFixture("g1", "GROUP_1", ntA, ntB, g1);

    const xi = xi433(poolA);
    const captain = xi[10] as number;
    const vice = xi[0] as number;

    // Submit + idempotent replace before the lock.
    const row = await submitLineup(ctx.db, {
      fantasyTeamId: teamA,
      scoringPeriodId: g1,
      playerIds: xi,
      captainPlayerId: captain,
      viceCaptainPlayerId: vice,
      now: BEFORE_LOCK,
    });
    expect(row.captainPlayerId).toBe(captain);
    const replaced = await submitLineup(ctx.db, {
      fantasyTeamId: teamA,
      scoringPeriodId: g1,
      playerIds: xi,
      captainPlayerId: vice,
      now: BEFORE_LOCK,
    });
    expect(replaced.captainPlayerId).toBe(vice);
    expect(replaced.viceCaptainPlayerId).toBeNull();

    // Locked at/after first kickoff.
    await expect(
      submitLineup(ctx.db, {
        fantasyTeamId: teamA,
        scoringPeriodId: g1,
        playerIds: xi,
        captainPlayerId: captain,
        now: AFTER_LOCK,
      }),
    ).rejects.toMatchObject({ code: "LINEUP_LOCKED" });

    // Illegal XI (10 players).
    await expect(
      submitLineup(ctx.db, {
        fantasyTeamId: teamA,
        scoringPeriodId: g1,
        playerIds: xi.slice(0, 10),
        captainPlayerId: captain,
        now: BEFORE_LOCK,
      }),
    ).rejects.toMatchObject({ code: "LINEUP_SIZE" });
  });

  it("rejects lineups for a best-ball league", async () => {
    const { teamA, poolA } = await buildLeague("BEST_BALL");
    const compId = await worldCupCompetitionId();
    const g1 = await periodIdByStage(compId, "GROUP_1");
    await expect(
      submitLineup(ctx.db, {
        fantasyTeamId: teamA,
        scoringPeriodId: g1,
        playerIds: xi433(poolA),
        captainPlayerId: xi433(poolA)[0] as number,
        now: BEFORE_LOCK,
      }),
    ).rejects.toMatchObject({ code: "FORMAT_NOT_SET_LINEUP" });
  });

  it("scores the submitted XI with a doubled captain, not the best ball", async () => {
    const compId = await worldCupCompetitionId();
    const { leagueId, teamA, poolA, ntA, ntB } = await buildLeague("SET_LINEUP", compId);
    const g1 = await periodIdByStage(compId, "GROUP_1");
    const fx = await seedFixture("g1", "GROUP_1", ntA, ntB, g1);

    const xi = xi433(poolA);
    const captain = xi[10] as number; // a FWD
    await submitLineup(ctx.db, {
      fantasyTeamId: teamA,
      scoringPeriodId: g1,
      playerIds: xi,
      captainPlayerId: captain,
      now: BEFORE_LOCK,
    });

    // Every XI player scores 10 and features. A NON-selected DEF scores 50:
    // best-ball would grab him; the submitted lineup must not.
    for (const pid of xi) {
      await giveScore(pid, fx, 10);
      await giveMinutes(pid, fx, 90);
    }
    const benchStar = poolA.DEF[4] as number; // not in the 4-3-3
    await giveScore(benchStar, fx, 50);
    await giveMinutes(benchStar, fx, 90);

    const standings = await computeStandings(ctx.db, leagueId);
    const a = standings.find((s) => s.fantasyTeamId === teamA);
    // 11 x 10 + captain doubled (+10) = 120. Best-ball would be >= 150.
    expect(a?.periods[0]?.points).toBe(120);
    expect(a?.periods[0]?.formation).toBe("4-3-3");
    expect(a?.total).toBe(120);
    const capSlot = a?.periods[0]?.xi.find((s) => s.playerId === captain);
    expect(capSlot?.points).toBe(20);
    expect(a?.periods[0]?.xi.some((s) => s.playerId === benchStar)).toBe(false);
  });

  it("promotes the vice-captain when the captain does not feature", async () => {
    const compId = await worldCupCompetitionId();
    const { leagueId, teamA, poolA, ntA, ntB } = await buildLeague("SET_LINEUP", compId);
    const g1 = await periodIdByStage(compId, "GROUP_1");
    const fx = await seedFixture("g1", "GROUP_1", ntA, ntB, g1);

    const xi = xi433(poolA);
    const captain = xi[10] as number;
    const vice = xi[5] as number; // a MID
    await submitLineup(ctx.db, {
      fantasyTeamId: teamA,
      scoringPeriodId: g1,
      playerIds: xi,
      captainPlayerId: captain,
      viceCaptainPlayerId: vice,
      now: BEFORE_LOCK,
    });

    // Everyone but the captain plays; captain scores 0 with 0 minutes.
    for (const pid of xi) {
      if (pid === captain) continue;
      await giveScore(pid, fx, 10);
      await giveMinutes(pid, fx, 90);
    }
    await giveMinutes(captain, fx, 0);

    const standings = await computeStandings(ctx.db, leagueId);
    const a = standings.find((s) => s.fantasyTeamId === teamA);
    // 10 players x 10 + vice doubled (+10) = 110.
    expect(a?.periods[0]?.points).toBe(110);
    expect(a?.periods[0]?.xi.find((s) => s.playerId === vice)?.points).toBe(20);
    expect(a?.periods[0]?.xi.find((s) => s.playerId === captain)?.points).toBe(0);
  });

  it("rolls a lineup forward into later periods until replaced", async () => {
    const compId = await worldCupCompetitionId();
    const { leagueId, teamA, poolA, ntA, ntB } = await buildLeague("SET_LINEUP", compId);
    const g1 = await periodIdByStage(compId, "GROUP_1");
    const g2 = await periodIdByStage(compId, "GROUP_2");
    await seedFixture("g1", "GROUP_1", ntA, ntB, g1);
    const fx2 = await seedFixture("g2", "GROUP_2", ntB, ntA, g2);

    const xi = xi433(poolA);
    await submitLineup(ctx.db, {
      fantasyTeamId: teamA,
      scoringPeriodId: g1,
      playerIds: xi,
      captainPlayerId: xi[0] as number,
      now: BEFORE_LOCK,
    });

    // Scores only in GROUP_2 - no lineup submitted for it.
    for (const pid of xi) {
      await giveScore(pid, fx2, 5);
      await giveMinutes(pid, fx2, 90);
    }

    const standings = await computeStandings(ctx.db, leagueId);
    const a = standings.find((s) => s.fantasyTeamId === teamA);
    // Rolled-forward XI: 11 x 5 + captain doubled (+5) = 60 in period 2.
    expect(a?.periods[1]?.points).toBe(60);
    // And 0 in period 1 (no scores there).
    expect(a?.periods[0]?.points).toBe(0);
  });

  it("leaves a best-ball league byte-identical even with lineup rows present", async () => {
    const compId = await worldCupCompetitionId();
    const { leagueId, teamA, poolA, ntA, ntB } = await buildLeague("BEST_BALL");
    const g1 = await periodIdByStage(compId, "GROUP_1");
    const fx = await seedFixture("g1", "GROUP_1", ntA, ntB, g1);

    const xi = xi433(poolA);
    for (const pid of xi) await giveScore(pid, fx, 10);

    const before = JSON.stringify(await computeStandings(ctx.db, leagueId));

    // Force a lineup row in (bypassing the service's format guard).
    await ctx.db.insert(lineup).values({
      fantasyTeamId: teamA,
      scoringPeriodId: g1,
      playerIds: xi,
      captainPlayerId: xi[0] as number,
    });

    const after = JSON.stringify(await computeStandings(ctx.db, leagueId));
    expect(after).toBe(before);
  });
});
