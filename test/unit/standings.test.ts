/**
 * Unit tests for the best-ball optimizer and the standings ranking ladder.
 */
import { describe, expect, it } from "vitest";

import type { Position } from "../../src/data/db/schema.js";
import {
  LEGAL_FORMATIONS,
  formationLabel,
  optimizeBestBall,
  type ScoredPlayer,
} from "../../src/data/standings/lineup.js";
import { rankStandings, type StandingsEntry } from "../../src/data/standings/standings.js";

/** Build a roster of n players of one position, each with a fixed point value. */
function squad(position: Position, n: number, points: number, startId: number): ScoredPlayer[] {
  return Array.from({ length: n }, (_, i) => ({
    playerId: startId + i,
    position,
    points,
  }));
}

/** A full legal 23-man roster (2 GK / 8 DEF / 8 MID / 5 FWD) all worth 0. */
function blankRoster(): ScoredPlayer[] {
  return [
    ...squad("GK", 2, 0, 100),
    ...squad("DEF", 8, 0, 200),
    ...squad("MID", 8, 0, 300),
    ...squad("FWD", 5, 0, 400),
  ];
}

describe("LEGAL_FORMATIONS", () => {
  it("derives exactly the four legal World Cup formations", () => {
    const labels = LEGAL_FORMATIONS.map(formationLabel).sort();
    expect(labels).toEqual(["4-3-3", "4-4-2", "5-2-3", "5-3-2"]);
  });

  it("every formation is 1 GK + 10 outfielders", () => {
    for (const f of LEGAL_FORMATIONS) {
      expect(f.GK).toBe(1);
      expect(f.DEF + f.MID + f.FWD).toBe(10);
    }
  });
});

describe("optimizeBestBall", () => {
  it("picks 11 players that form a legal formation", () => {
    const result = optimizeBestBall(blankRoster());
    expect(result.xi).toHaveLength(11);
    expect(result.points).toBe(0);
  });

  it("chooses the formation that maximises points", () => {
    // Make MIDs very valuable: 4-4-2 (4 MID) should beat 4-3-3 (3 MID).
    const roster: ScoredPlayer[] = [
      ...squad("GK", 2, 1, 100),
      ...squad("DEF", 8, 1, 200),
      ...squad("MID", 8, 10, 300), // midfielders worth a lot
      ...squad("FWD", 5, 1, 400),
    ];
    const result = optimizeBestBall(roster);
    // 4-4-2: 1 + 4*1 + 4*10 + 2*1 = 47. 4-3-3: 1 + 4 + 30 + 3 = 38.
    // 5-3-2: 1 + 5 + 30 + 2 = 38. 5-2-3: 1 + 5 + 20 + 3 = 29.
    expect(formationLabel(result.formation)).toBe("4-4-2");
    expect(result.points).toBe(47);
  });

  it("prefers 5 defenders when defenders carry the points", () => {
    const roster: ScoredPlayer[] = [
      ...squad("GK", 2, 1, 100),
      ...squad("DEF", 8, 10, 200), // defenders worth a lot
      ...squad("MID", 8, 1, 300),
      ...squad("FWD", 5, 1, 400),
    ];
    const result = optimizeBestBall(roster);
    // 5-3-2: 1 + 50 + 3 + 2 = 56; 5-2-3: 1 + 50 + 2 + 3 = 56 (tie).
    // Canonical order keeps the first -> 5-2-3 appears before 5-3-2.
    expect(result.formation.DEF).toBe(5);
    expect(result.points).toBe(56);
  });

  it("takes the highest-scoring players within a position", () => {
    // 8 DEF: four worth 9, four worth 1. A 4-DEF formation must take the 9s.
    const roster: ScoredPlayer[] = [
      ...squad("GK", 2, 0, 100),
      ...squad("DEF", 4, 9, 200),
      ...squad("DEF", 4, 1, 210),
      ...squad("MID", 8, 0, 300),
      ...squad("FWD", 5, 0, 400),
    ];
    const result = optimizeBestBall(roster);
    // Best XI uses the 4 nines: any formation has >= 4 DEF, so DEF block = 36.
    const defPoints = result.xi
      .filter((p) => p.position === "DEF")
      .reduce((s, p) => s + p.points, 0);
    expect(defPoints).toBeGreaterThanOrEqual(36);
  });

  it("throws on a roster too thin to field any XI", () => {
    expect(() => optimizeBestBall(squad("GK", 1, 0, 1))).toThrow();
  });
});

describe("rankStandings (section 5.3 tie-breaker ladder)", () => {
  function entry(
    teamId: number,
    total: number,
    finalMatchPoints = 0,
    tournamentGoals = 0,
    tournamentAssists = 0,
  ): Omit<StandingsEntry, "rank"> {
    return {
      fantasyTeamId: teamId,
      managerId: teamId,
      teamName: `Team ${teamId}`,
      total,
      tieBreakers: { finalMatchPoints, tournamentGoals, tournamentAssists },
      periods: [],
    };
  }

  it("ranks by total points, descending", () => {
    const ranked = rankStandings([entry(1, 40), entry(2, 90), entry(3, 65)]);
    expect(ranked.map((r) => r.fantasyTeamId)).toEqual([2, 3, 1]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("breaks an equal total by Final-match points", () => {
    const ranked = rankStandings([
      entry(1, 80, 5),
      entry(2, 80, 12),
      entry(3, 80, 9),
    ]);
    expect(ranked.map((r) => r.fantasyTeamId)).toEqual([2, 3, 1]);
  });

  it("falls through to goals, then assists", () => {
    const ranked = rankStandings([
      entry(1, 50, 4, 3, 10),
      entry(2, 50, 4, 3, 14),
      entry(3, 50, 4, 7, 0),
    ]);
    // team 3 wins on goals; teams 1 & 2 tie on goals -> assists decides.
    expect(ranked.map((r) => r.fantasyTeamId)).toEqual([3, 2, 1]);
  });

  it("shares the rank when teams tie on every ranked key", () => {
    const ranked = rankStandings([
      entry(1, 70, 5, 2, 1),
      entry(2, 70, 5, 2, 1),
      entry(3, 60, 0, 0, 0),
    ]);
    // teams 1 and 2 are a full tie -> both rank 1; next team is rank 3.
    expect(ranked.map((r) => r.rank)).toEqual([1, 1, 3]);
  });
});
