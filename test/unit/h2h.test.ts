/**
 * Unit tests for head-to-head (Phase 9 Priority 2): round-robin schedule
 * properties (coverage, byes, balance, determinism) and the pure derived
 * results / table / rivalry builders.
 */
import { describe, expect, it } from "vitest";

import type { PeriodRef } from "../../src/data/competition/periods.js";
import type { MatchupRow } from "../../src/data/db/schema.js";
import {
  buildH2hTable,
  buildMatchupResults,
  buildRivalries,
  type MatchupResult,
} from "../../src/data/h2h/results.js";
import { generateRoundRobin } from "../../src/data/h2h/schedule.js";

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

describe("generateRoundRobin", () => {
  it("even count: every pair meets exactly once per cycle, no repeats in a round", () => {
    const teams = [1, 2, 3, 4];
    const rounds = generateRoundRobin(teams, 3);
    const met = new Map<string, number>();
    for (const round of rounds) {
      expect(round).toHaveLength(2);
      const seen = new Set<number>();
      for (const p of round) {
        expect(seen.has(p.home)).toBe(false);
        expect(seen.has(p.away)).toBe(false);
        seen.add(p.home);
        seen.add(p.away);
        met.set(pairKey(p.home, p.away), (met.get(pairKey(p.home, p.away)) ?? 0) + 1);
      }
    }
    expect(met.size).toBe(6); // C(4,2)
    for (const n of met.values()) expect(n).toBe(1);
  });

  it("odd count: one bye per round, each team sits out once per cycle", () => {
    const teams = [1, 2, 3, 4, 5];
    const rounds = generateRoundRobin(teams, 5);
    const byes: number[] = [];
    for (const round of rounds) {
      expect(round).toHaveLength(2); // 4 playing, 1 bye
      const playing = new Set(round.flatMap((p) => [p.home, p.away]));
      const sitting = teams.filter((t) => !playing.has(t));
      expect(sitting).toHaveLength(1);
      byes.push(sitting[0] as number);
    }
    expect([...byes].sort((a, b) => a - b)).toEqual(teams);
  });

  it("wraps balanced when periods exceed rounds (4 teams, 9 periods)", () => {
    const rounds = generateRoundRobin([1, 2, 3, 4], 9);
    expect(rounds).toHaveLength(9);
    const met = new Map<string, number>();
    for (const round of rounds) {
      for (const p of round) {
        met.set(pairKey(p.home, p.away), (met.get(pairKey(p.home, p.away)) ?? 0) + 1);
      }
    }
    // 9 periods / 3 rounds-per-cycle = every pair meets exactly 3 times.
    expect(met.size).toBe(6);
    for (const n of met.values()) expect(n).toBe(3);
  });

  it("is deterministic and order-insensitive", () => {
    const a = generateRoundRobin([3, 1, 4, 2], 5);
    const b = generateRoundRobin([1, 2, 3, 4], 5);
    expect(a).toEqual(b);
  });

  it("truncates to a balanced partial round-robin when periods < rounds", () => {
    const rounds = generateRoundRobin([1, 2, 3, 4, 5, 6], 2);
    expect(rounds).toHaveLength(2);
    const perTeam = new Map<number, number>();
    for (const round of rounds) {
      expect(round).toHaveLength(3);
      for (const p of round) {
        perTeam.set(p.home, (perTeam.get(p.home) ?? 0) + 1);
        perTeam.set(p.away, (perTeam.get(p.away) ?? 0) + 1);
      }
    }
    for (const n of perTeam.values()) expect(n).toBe(2);
  });
});

// --- derived results ---------------------------------------------------------

const P1: PeriodRef = { id: 11, ordinal: 1, label: "Group 1", stageCode: "GROUP_1" };
const P2: PeriodRef = { id: 12, ordinal: 2, label: "Group 2", stageCode: "GROUP_2" };
const periodById = new Map([
  [11, P1],
  [12, P2],
]);

function mkMatchup(id: number, periodId: number, home: number, away: number): MatchupRow {
  return {
    id,
    leagueId: 1,
    scoringPeriodId: periodId,
    homeFantasyTeamId: home,
    awayFantasyTeamId: away,
    createdAt: new Date("2026-06-01T00:00:00Z"),
  };
}

function pts(entries: Array<[number, Array<[number, number]>]>): Map<number, Map<number, number>> {
  return new Map(entries.map(([team, m]) => [team, new Map(m)]));
}

describe("buildMatchupResults", () => {
  it("decides W/D/L only for finalized periods", () => {
    const results = buildMatchupResults(
      [mkMatchup(1, 11, 100, 200), mkMatchup(2, 12, 200, 100)],
      periodById,
      pts([
        [100, [[1, 50], [2, 30]]],
        [200, [[1, 40], [2, 30]]],
      ]),
      new Set([1]),
    );
    expect(results[0]).toMatchObject({
      ordinal: 1,
      homePoints: 50,
      awayPoints: 40,
      finalized: true,
      outcome: "HOME",
    });
    expect(results[1]).toMatchObject({
      ordinal: 2,
      homePoints: 30,
      awayPoints: 30,
      finalized: false,
      outcome: null,
    });
  });

  it("skips matchups whose period is unknown", () => {
    const results = buildMatchupResults(
      [mkMatchup(1, 999, 100, 200)],
      periodById,
      pts([]),
      new Set(),
    );
    expect(results).toEqual([]);
  });
});

function res(
  id: number,
  ordinal: number,
  home: number,
  away: number,
  hp: number,
  ap: number,
  finalized = true,
): MatchupResult {
  return {
    matchupId: id,
    scoringPeriodId: 10 + ordinal,
    ordinal,
    label: `P${ordinal}`,
    homeFantasyTeamId: home,
    awayFantasyTeamId: away,
    homePoints: hp,
    awayPoints: ap,
    finalized,
    outcome: !finalized ? null : hp > ap ? "HOME" : ap > hp ? "AWAY" : "DRAW",
  };
}

describe("buildH2hTable", () => {
  const teams = [
    { fantasyTeamId: 100, teamName: "A", totalPoints: 90 },
    { fantasyTeamId: 200, teamName: "B", totalPoints: 80 },
    { fantasyTeamId: 300, teamName: "C", totalPoints: 85 },
  ];

  it("awards 3/1/0 and ranks by H2H points then total points", () => {
    const table = buildH2hTable(
      [
        res(1, 1, 100, 200, 50, 40), // A beats B
        res(2, 2, 200, 300, 30, 30), // B draws C
        res(3, 3, 300, 100, 20, 10), // C beats A
      ],
      teams,
    );
    // A: W1 L1 = 3 pts (total 90); C: W1 D1 = 4 pts; B: D1 L1 = 1 pt.
    expect(table.map((t) => t.fantasyTeamId)).toEqual([300, 100, 200]);
    expect(table[0]).toMatchObject({ rank: 1, wins: 1, draws: 1, losses: 0, h2hPoints: 4 });
    expect(table[1]).toMatchObject({ rank: 2, played: 2, h2hPoints: 3 });
    expect(table[2]).toMatchObject({ rank: 3, h2hPoints: 1 });
  });

  it("ignores unfinalized results and shares ranks on full ties", () => {
    const table = buildH2hTable([res(1, 1, 100, 200, 50, 40, false)], [
      { fantasyTeamId: 100, teamName: "A", totalPoints: 70 },
      { fantasyTeamId: 200, teamName: "B", totalPoints: 70 },
      { fantasyTeamId: 300, teamName: "C", totalPoints: 60 },
    ]);
    expect(table.map((t) => [t.rank, t.h2hPoints, t.played])).toEqual([
      [1, 0, 0],
      [1, 0, 0],
      [3, 0, 0],
    ]);
  });
});

describe("buildRivalries", () => {
  it("accumulates the pairwise record across finalized meetings", () => {
    const rivals = buildRivalries([
      res(1, 1, 100, 200, 50, 40), // 100 beats 200
      res(2, 2, 200, 100, 45, 20), // 200 beats 100
      res(3, 3, 100, 200, 30, 30), // draw
      res(4, 4, 100, 300, 10, 20), // 300 beats 100
      res(5, 5, 100, 200, 99, 0, false), // not finalized - ignored
    ]);
    expect(rivals).toEqual([
      { teamAId: 100, teamBId: 200, aWins: 1, bWins: 1, draws: 1 },
      { teamAId: 100, teamBId: 300, aWins: 0, bWins: 1, draws: 0 },
    ]);
  });
});
