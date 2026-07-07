/**
 * Unit tests for the deterministic stage recap + power rankings
 * (phase-03 3.3). Movement must equal the diff of consecutive snapshot
 * ranks; the recap object must be a pure function of its inputs.
 */
import { describe, expect, it } from "vitest";

import type { MatchupResult } from "../../src/data/h2h/results.js";
import {
  buildPowerRankings,
  buildStageRecap,
} from "../../src/data/social/recap.js";
import type { StandingsEntry } from "../../src/data/standings/standings.js";

function entry(
  id: number,
  name: string,
  total: number,
  stagePoints: number,
  xi: Array<{ playerId: number; fullName: string; points: number }> = [],
): StandingsEntry {
  return {
    rank: 0,
    fantasyTeamId: id,
    managerId: id,
    teamName: name,
    total,
    tieBreakers: { finalMatchPoints: 0, tournamentGoals: 0, tournamentAssists: 0 },
    periods: [
      {
        stage: "R16",
        formation: "4-3-3",
        points: stagePoints,
        xi: xi.map((s) => ({ ...s, position: "MID" as const })),
      },
    ],
  };
}

describe("buildPowerRankings", () => {
  const entries = [
    entry(1, "Alpha", 100, 30), // power 130
    entry(2, "Beta", 110, 10), // power 120
    entry(3, "Gamma", 90, 45), // power 135 - form jumps them to #1
  ];

  it("orders by season total + stage form", () => {
    const pr = buildPowerRankings(entries, "R16", new Map(), null);
    expect(pr.map((p) => p.teamName)).toEqual(["Gamma", "Alpha", "Beta"]);
    expect(pr[0]).toMatchObject({ rank: 1, powerScore: 135 });
  });

  it("movement equals the diff of consecutive snapshot ranks", () => {
    const prev = new Map([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    const curr = new Map([
      [1, 2],
      [2, 3],
      [3, 1],
    ]);
    const pr = buildPowerRankings(entries, "R16", curr, prev);
    expect(pr.find((p) => p.fantasyTeamId === 3)?.movement).toBe(2); // 3 -> 1
    expect(pr.find((p) => p.fantasyTeamId === 1)?.movement).toBe(-1); // 1 -> 2
  });

  it("movement is null without a previous snapshot", () => {
    const pr = buildPowerRankings(entries, "R16", new Map([[1, 1]]), null);
    expect(pr.every((p) => p.movement === null)).toBe(true);
  });
});

describe("buildStageRecap", () => {
  const entries = [
    entry(1, "Alpha", 100, 30, [
      { playerId: 9, fullName: "Star Nine", points: 21 },
    ]),
    entry(2, "Beta", 110, 10, [
      { playerId: 4, fullName: "Solid Four", points: 8 },
    ]),
  ];

  it("is deterministic and hand-computable without matchups", () => {
    const a = buildStageRecap("R16", entries, [], new Map(), null);
    const b = buildStageRecap("R16", entries, [], new Map(), null);
    expect(a).toEqual(b);
    expect(a.managerOfStage).toEqual({ teamNames: ["Alpha"], points: 30 });
    expect(a.topHaul).toEqual({
      playerName: "Star Nine",
      teamName: "Alpha",
      points: 21,
    });
    expect(a.biggestBlowout).toEqual({
      winnerName: "Alpha",
      loserName: "Beta",
      margin: 20,
      kind: "STAGE",
    });
  });

  it("prefers the widest H2H margin for the blowout", () => {
    const matchups: MatchupResult[] = [
      {
        matchupId: 1,
        scoringPeriodId: 15,
        ordinal: 5,
        label: "Round of 16",
        homeFantasyTeamId: 1,
        awayFantasyTeamId: 2,
        homePoints: 30,
        awayPoints: 10,
        finalized: true,
        outcome: "HOME",
      },
    ];
    const recap = buildStageRecap("R16", entries, matchups, new Map(), null);
    expect(recap.biggestBlowout).toEqual({
      winnerName: "Alpha",
      loserName: "Beta",
      margin: 20,
      kind: "H2H",
    });
  });
});
