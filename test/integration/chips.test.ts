/**
 * Integration tests for chips (Phase 9 Priority 3): flag gate, captain
 * layer, one-use/no-stack/lock rules, the standings overlay for all three
 * chips in both formats, and - critically - that toggling the flag off
 * restores byte-identical standings (score_entry untouched).
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { playChip, setPeriodCaptain } from "../../src/data/chips/service.js";
import {
  fixture,
  nationalTeam,
  player,
  scoreEntry,
  statLine,
  type Position,
  type Stage,
} from "../../src/data/db/schema.js";
import { setFlag } from "../../src/data/league/feature-flags.js";
import { submitLineup } from "../../src/data/lineup/service.js";
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

async function periodIdByStage(stage: Stage): Promise<number> {
  const compId = await worldCupCompetitionId();
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
): Promise<number[]> {
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
  return order;
}

async function seedFixture(stage: Stage, home: number, away: number): Promise<number> {
  const periodId = await periodIdByStage(stage);
  const [row] = await ctx.db
    .insert(fixture)
    .values({
      sourceFixtureId: `fx-${Math.random()}`,
      stage,
      scoringPeriodId: periodId,
      homeTeamId: home,
      awayTeamId: away,
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

interface Built {
  leagueId: number;
  teamA: number;
  poolA: Record<Position, number[]>;
  rosterA: number[];
  ntA: number;
  ntB: number;
}

async function buildLeague(format: "BEST_BALL" | "SET_LINEUP" = "BEST_BALL"): Promise<Built> {
  const ntA = await seedNationalTeam("A");
  const ntB = await seedNationalTeam("B");
  const poolA = await seedPool(ntA);
  const poolB = await seedPool(ntB);
  const owner = await createManager(ctx.db, {
    firebaseUid: `o-${Math.random()}`,
    displayName: "Owner",
    email: `o-${Math.random()}@x.com`,
  });
  const compId = await worldCupCompetitionId();
  const created = await createLeague(ctx.db, {
    ownerManagerId: owner.id,
    name: "Chips League",
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
  const joined = await acceptInvite(ctx.db, { token: invite.token, managerId: joiner.id });
  const rosterA = await buildRoster(created.ownerTeam.id, poolA);
  await buildRoster(joined.team.id, poolB);
  if (format === "BEST_BALL") {
    await ctx.db.execute(
      sql`UPDATE league SET competition_id = ${compId} WHERE id = ${created.league.id}`,
    );
  }
  return { leagueId: created.league.id, teamA: created.ownerTeam.id, poolA, rosterA, ntA, ntB };
}

/** An XI's worth of scorers: 1 GK + 5 DEF + 3 MID + 2 FWD, 10 pts each. */
function scorers(pool: Record<Position, number[]>): number[] {
  return [
    ...pool.GK.slice(0, 1),
    ...pool.DEF.slice(0, 5),
    ...pool.MID.slice(0, 3),
    ...pool.FWD.slice(0, 2),
  ];
}

describe("chips (integration)", () => {
  beforeEach(async () => {
    await ctx.resetDb();
  });

  it("rejects everything while the chips flag is off", async () => {
    const { teamA, poolA } = await buildLeague();
    const g1 = await periodIdByStage("GROUP_1");
    await expect(
      setPeriodCaptain(ctx.db, {
        fantasyTeamId: teamA,
        scoringPeriodId: g1,
        playerId: poolA.GK[0] as number,
        now: BEFORE_LOCK,
      }),
    ).rejects.toMatchObject({ code: "CHIPS_FLAG_DISABLED" });
    await expect(
      playChip(ctx.db, {
        fantasyTeamId: teamA,
        scoringPeriodId: g1,
        chip: "STAGE_BOOST",
        now: BEFORE_LOCK,
      }),
    ).rejects.toMatchObject({ code: "CHIPS_FLAG_DISABLED" });
  });

  it("best-ball: captain x2, TRIPLE_CAPTAIN x3, one-use and no-stack rules", async () => {
    const { leagueId, teamA, poolA, ntA, ntB } = await buildLeague();
    await setFlag(ctx.db, leagueId, "chips", { enabled: true });
    const g1 = await periodIdByStage("GROUP_1");
    const fx1 = await seedFixture("GROUP_1", ntA, ntB);
    const xi = scorers(poolA);
    for (const pid of xi) await giveScore(pid, fx1, 10); // best-ball 110

    const captain = poolA.GK[0] as number;
    await setPeriodCaptain(ctx.db, {
      fantasyTeamId: teamA,
      scoringPeriodId: g1,
      playerId: captain,
      now: BEFORE_LOCK,
    });
    let standings = await computeStandings(ctx.db, leagueId);
    let a = standings.find((s) => s.fantasyTeamId === teamA);
    expect(a?.periods[0]?.points).toBe(120); // captain doubled

    await playChip(ctx.db, {
      fantasyTeamId: teamA,
      scoringPeriodId: g1,
      chip: "TRIPLE_CAPTAIN",
      now: BEFORE_LOCK,
    });
    standings = await computeStandings(ctx.db, leagueId);
    a = standings.find((s) => s.fantasyTeamId === teamA);
    expect(a?.periods[0]?.points).toBe(130); // captain tripled
    expect(a?.periods[0]?.xi.find((s) => s.playerId === captain)?.points).toBe(30);

    // One use per chip.
    const g2 = await periodIdByStage("GROUP_2");
    await expect(
      playChip(ctx.db, {
        fantasyTeamId: teamA,
        scoringPeriodId: g2,
        chip: "TRIPLE_CAPTAIN",
        now: BEFORE_LOCK,
      }),
    ).rejects.toMatchObject({ code: "CHIP_ALREADY_USED" });
    // No stacking on a period.
    await expect(
      playChip(ctx.db, {
        fantasyTeamId: teamA,
        scoringPeriodId: g1,
        chip: "STAGE_BOOST",
        now: BEFORE_LOCK,
      }),
    ).rejects.toMatchObject({ code: "CHIP_PERIOD_TAKEN" });
  });

  it("best-ball: BENCH_BOOST scores all 23; STAGE_BOOST doubles the total", async () => {
    const { leagueId, teamA, poolA, rosterA, ntA, ntB } = await buildLeague();
    await setFlag(ctx.db, leagueId, "chips", { enabled: true });
    const g1 = await periodIdByStage("GROUP_1");
    const g2 = await periodIdByStage("GROUP_2");
    const fx1 = await seedFixture("GROUP_1", ntA, ntB);
    const fx2 = await seedFixture("GROUP_2", ntB, ntA);

    for (const pid of rosterA) await giveScore(pid, fx1, 1); // all 23 score 1
    for (const pid of scorers(poolA)) await giveScore(pid, fx2, 10); // XI 110

    await playChip(ctx.db, {
      fantasyTeamId: teamA,
      scoringPeriodId: g1,
      chip: "BENCH_BOOST",
      now: BEFORE_LOCK,
    });
    await playChip(ctx.db, {
      fantasyTeamId: teamA,
      scoringPeriodId: g2,
      chip: "STAGE_BOOST",
      now: BEFORE_LOCK,
    });

    const standings = await computeStandings(ctx.db, leagueId);
    const a = standings.find((s) => s.fantasyTeamId === teamA);
    expect(a?.periods[0]?.points).toBe(23); // whole roster, not best XI (11)
    expect(a?.periods[0]?.formation).toBe("ALL");
    expect(a?.periods[0]?.xi).toHaveLength(23);
    expect(a?.periods[1]?.points).toBe(220); // 110 doubled
    expect(a?.total).toBe(243);
  });

  it("locks selections at first kickoff and validates the captain's roster", async () => {
    const { leagueId, teamA, poolA, ntA, ntB } = await buildLeague();
    await setFlag(ctx.db, leagueId, "chips", { enabled: true });
    const g1 = await periodIdByStage("GROUP_1");
    await seedFixture("GROUP_1", ntA, ntB);

    await expect(
      setPeriodCaptain(ctx.db, {
        fantasyTeamId: teamA,
        scoringPeriodId: g1,
        playerId: poolA.GK[0] as number,
        now: AFTER_LOCK,
      }),
    ).rejects.toMatchObject({ code: "SELECTION_LOCKED" });
    await expect(
      playChip(ctx.db, {
        fantasyTeamId: teamA,
        scoringPeriodId: g1,
        chip: "STAGE_BOOST",
        now: AFTER_LOCK,
      }),
    ).rejects.toMatchObject({ code: "SELECTION_LOCKED" });
    await expect(
      setPeriodCaptain(ctx.db, {
        fantasyTeamId: teamA,
        scoringPeriodId: g1,
        playerId: 999999,
        now: BEFORE_LOCK,
      }),
    ).rejects.toMatchObject({ code: "PLAYER_NOT_ON_ROSTER" });
    // TRIPLE_CAPTAIN needs a captain first (best-ball).
    await expect(
      playChip(ctx.db, {
        fantasyTeamId: teamA,
        scoringPeriodId: g1,
        chip: "TRIPLE_CAPTAIN",
        now: BEFORE_LOCK,
      }),
    ).rejects.toMatchObject({ code: "TC_REQUIRES_CAPTAIN" });
  });

  it("turning the flag off restores byte-identical standings", async () => {
    const { leagueId, teamA, poolA, ntA, ntB } = await buildLeague();
    const g1 = await periodIdByStage("GROUP_1");
    const fx1 = await seedFixture("GROUP_1", ntA, ntB);
    for (const pid of scorers(poolA)) await giveScore(pid, fx1, 10);

    const baseline = JSON.stringify(await computeStandings(ctx.db, leagueId));

    await setFlag(ctx.db, leagueId, "chips", { enabled: true });
    await setPeriodCaptain(ctx.db, {
      fantasyTeamId: teamA,
      scoringPeriodId: g1,
      playerId: poolA.GK[0] as number,
      now: BEFORE_LOCK,
    });
    await playChip(ctx.db, {
      fantasyTeamId: teamA,
      scoringPeriodId: g1,
      chip: "STAGE_BOOST",
      now: BEFORE_LOCK,
    });
    const withChips = await computeStandings(ctx.db, leagueId);
    expect(
      withChips.find((s) => s.fantasyTeamId === teamA)?.periods[0]?.points,
    ).toBe(240); // (110 + 10 captain) * 2

    await setFlag(ctx.db, leagueId, "chips", { enabled: false });
    expect(JSON.stringify(await computeStandings(ctx.db, leagueId))).toBe(baseline);
  });

  it("set-lineup: captain comes from the lineup; TRIPLE_CAPTAIN triples it", async () => {
    const { leagueId, teamA, poolA, ntA, ntB } = await buildLeague("SET_LINEUP");
    await setFlag(ctx.db, leagueId, "chips", { enabled: true });
    const g1 = await periodIdByStage("GROUP_1");
    const fx1 = await seedFixture("GROUP_1", ntA, ntB);

    await expect(
      setPeriodCaptain(ctx.db, {
        fantasyTeamId: teamA,
        scoringPeriodId: g1,
        playerId: poolA.GK[0] as number,
        now: BEFORE_LOCK,
      }),
    ).rejects.toMatchObject({ code: "CAPTAIN_VIA_LINEUP" });

    const xi = [
      ...poolA.GK.slice(0, 1),
      ...poolA.DEF.slice(0, 4),
      ...poolA.MID.slice(0, 3),
      ...poolA.FWD.slice(0, 3),
    ];
    const captain = xi[0] as number;
    await submitLineup(ctx.db, {
      fantasyTeamId: teamA,
      scoringPeriodId: g1,
      playerIds: xi,
      captainPlayerId: captain,
      now: BEFORE_LOCK,
    });
    for (const pid of xi) {
      await giveScore(pid, fx1, 10);
      await ctx.db.insert(statLine).values({
        playerId: pid,
        fixtureId: fx1,
        minutesPlayed: 90,
        sourceRevision: "test",
      });
    }

    await playChip(ctx.db, {
      fantasyTeamId: teamA,
      scoringPeriodId: g1,
      chip: "TRIPLE_CAPTAIN",
      now: BEFORE_LOCK,
    });
    const standings = await computeStandings(ctx.db, leagueId);
    const a = standings.find((s) => s.fantasyTeamId === teamA);
    expect(a?.periods[0]?.points).toBe(130); // 110 + captain x3 (+20)
    expect(a?.periods[0]?.xi.find((s) => s.playerId === captain)?.points).toBe(30);
  });
});
