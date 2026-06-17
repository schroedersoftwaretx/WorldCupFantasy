/**
 * Unit tests for the SofaScore mapping.
 *
 * Drives the pure mapper against a committed fixture shaped like the real
 * /event + /event/{id}/lineups + /event/{id}/incidents payloads, then runs the
 * mapped lines through the scoring engine. This is the offline guarantee that
 * SofaScore's free per-player data — crosses, passes, tackles, shots, saves,
 * plus goals/cards/own-goals from the incidents feed — flows all the way to
 * points without a paid API.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { Position } from "../../src/data/db/schema.js";
import {
  aggregateSsIncidents,
  indexSsStandings,
  mapSsFixtures,
  mapSsFixtureStats,
  mapSsSquads,
  mapSsStage,
  mapSsStatus,
  ssRegEt,
  type SsEvent,
  type SsIncident,
  type SsLineups,
  type SsTeamPlayers,
} from "../../src/data/provider/sofascore-mapping.js";
import { DEFAULT_RULESET } from "../../src/data/scoring/ruleset.js";
import { scoreStatLine, type ScorableStatLine } from "../../src/data/scoring/score.js";

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "sofascore",
  "fixture-10230532.json",
);

interface FixtureFile {
  event: SsEvent;
  lineups: SsLineups;
  incidents: SsIncident[];
}

async function loadFixture(): Promise<FixtureFile> {
  return JSON.parse(await readFile(FIXTURE, "utf8")) as FixtureFile;
}

describe("mapSsStage", () => {
  it("maps group matchdays from the round number", () => {
    expect(mapSsStage("FIFA World Cup, Group A", "Group A", { round: 1 })).toBe("GROUP_1");
    expect(mapSsStage("FIFA World Cup, Group A", "Group A", { round: 2 })).toBe("GROUP_2");
    expect(mapSsStage("FIFA World Cup, Group A", "Group A", { round: 3 })).toBe("GROUP_3");
  });
  it("maps knockout stages from cupRoundType", () => {
    expect(mapSsStage("FIFA World Cup, Knockout stage", null, { cupRoundType: 32 })).toBe("R32");
    expect(mapSsStage("FIFA World Cup, Knockout stage", null, { cupRoundType: 16 })).toBe("R16");
    expect(mapSsStage("FIFA World Cup, Knockout stage", null, { cupRoundType: 8 })).toBe("QF");
    expect(mapSsStage("FIFA World Cup, Knockout stage", null, { cupRoundType: 4 })).toBe("SF");
    expect(mapSsStage("FIFA World Cup, Knockout stage", null, { cupRoundType: 2 })).toBe("FINAL");
  });
  it("recognises the third-place play-off before the semis", () => {
    expect(
      mapSsStage("FIFA World Cup", null, { name: "Play-off for third place", cupRoundType: 4 }),
    ).toBe("THIRD_PLACE");
  });
  it("falls back to the round name when cupRoundType is absent", () => {
    expect(mapSsStage("FIFA World Cup", null, { name: "Round of 16" })).toBe("R16");
    expect(mapSsStage("FIFA World Cup", null, { name: "Quarterfinals" })).toBe("QF");
  });
  it("throws on an unrecognised stage", () => {
    expect(() => mapSsStage("Mystery Cup", null, { round: 9 })).toThrow();
  });
});

describe("mapSsStatus + ssRegEt", () => {
  it("maps status type to our enum", () => {
    expect(mapSsStatus({ type: "finished" })).toBe("FINISHED");
    expect(mapSsStatus({ type: "inprogress" })).toBe("LIVE");
    expect(mapSsStatus({ type: "notstarted" })).toBe("SCHEDULED");
    expect(mapSsStatus({ type: "postponed" })).toBe("SCHEDULED");
  });
  it("reads reg+ET score, preferring overtime and ignoring the shootout", () => {
    // 90-minute game: normaltime.
    expect(ssRegEt({ normaltime: 2, current: 2, penalties: 0 })).toBe(2);
    // ET game decided on penalties: overtime holds reg+ET, penalties excluded.
    expect(ssRegEt({ normaltime: 1, overtime: 2, current: 2, penalties: 4 })).toBe(2);
    expect(ssRegEt(undefined)).toBeNull();
  });
});

describe("indexSsStandings + mapSsSquads", () => {
  it("extracts group letters and builds squads, skipping position-less players", () => {
    const groups = [
      { name: "Group A", rows: [{ team: { id: 4713, name: "England" } }] },
      { name: "Group B", rows: [{ team: { id: 4702, name: "Wales" } }] },
    ];
    const byTeam = indexSsStandings(groups);
    expect(byTeam.get("4713")).toBe("A");
    expect(byTeam.get("4702")).toBe("B");

    const teams: SsTeamPlayers[] = [
      {
        teamId: 4713,
        teamName: "England",
        players: [
          { player: { id: 138530, name: "Jordan Pickford", position: "G" } },
          { player: { id: 999999, name: "No Position" } }, // skipped
        ],
      },
    ];
    const squads = mapSsSquads(teams, byTeam);
    expect(squads).toHaveLength(1);
    expect(squads[0]!.team.groupLabel).toBe("A");
    expect(squads[0]!.players).toHaveLength(1);
    expect(squads[0]!.players[0]).toMatchObject({ sourcePlayerId: "138530", position: "GK" });
  });
});

describe("aggregateSsIncidents", () => {
  it("counts goals, own goals, cards (skipping rescinded), and missed penalties", async () => {
    const { incidents } = await loadFixture();
    const agg = aggregateSsIncidents(incidents);
    expect(agg.get("814590")).toMatchObject({ goals: 2 });
    expect(agg.get("94758")).toMatchObject({ ownGoals: 1, yellowCards: 1 });
    expect(agg.get("20602")).toMatchObject({ redCards: 1 });
    expect(agg.get("859765")).toMatchObject({ penaltiesMissed: 1 });
    // Danny Ward's yellow was rescinded -> not counted.
    expect(agg.get("197428")?.yellowCards ?? 0).toBe(0);
  });
});

describe("mapSsFixtureStats", () => {
  it("maps the detailed per-player fields from lineups + incidents", async () => {
    const { event, lineups, incidents } = await loadFixture();
    const [fixture] = mapSsFixtures([event]);
    expect(fixture).toMatchObject({ stage: "GROUP_3", status: "FINISHED", homeScore: 3, awayScore: 0 });

    const lines = mapSsFixtureStats(lineups, incidents, fixture!, "rev-1");
    expect(lines).toHaveLength(8);
    const by = new Map(lines.map((l) => [l.sourcePlayerId, l]));

    const pickford = by.get("138530")!;
    expect(pickford.saves).toBe(2);
    expect(pickford.goalsConceded).toBe(0); // GK, team conceded 0
    expect(pickford.passesCompleted).toBe(20);
    expect(pickford.teamScoredInRegulationAndEt).toBe(3);
    expect(pickford.teamConcededInRegulationAndEt).toBe(0);

    const stones = by.get("152077")!;
    expect(stones.tacklesSuccessful).toBe(3);
    expect(stones.crosses).toBe(2); // accurateCross
    expect(stones.passesCompleted).toBe(30);

    const rashford = by.get("814590")!;
    expect(rashford.goals).toBe(2);
    expect(rashford.shotsOnTarget).toBe(3);
    expect(rashford.shotsOffTarget).toBe(2); // shotOffTarget 1 + blocked 1

    const ward = by.get("197428")!;
    expect(ward.saves).toBe(4);
    expect(ward.penaltiesSaved).toBe(1);
    expect(ward.goalsConceded).toBe(3); // GK, team conceded 3

    const davies = by.get("94758")!;
    expect(davies.ownGoals).toBe(1);
    expect(davies.yellowCards).toBe(1);

    const allen = by.get("20602")!;
    expect(allen.redCards).toBe(1);
    expect(allen.minutesPlayed).toBe(30);
  });

  it("scores the mapped lines end-to-end", async () => {
    const { event, lineups, incidents } = await loadFixture();
    const [fixture] = mapSsFixtures([event]);
    const by = new Map(mapSsFixtureStats(lineups, incidents, fixture!, "rev-1").map((l) => [l.sourcePlayerId, l]));
    const pos: Record<string, Position> = {
      "138530": "GK",
      "152077": "DEF",
      "814590": "FWD",
      "859765": "MID",
      "786028": "MID",
      "197428": "GK",
      "94758": "DEF",
      "20602": "MID",
    };
    const pointsOf = (id: string) =>
      scoreStatLine(by.get(id)! as ScorableStatLine, pos[id]!, DEFAULT_RULESET).points;

    expect(pointsOf("138530")).toBe(15); // GK: +saves +clean sheet +passes +win
    expect(pointsOf("152077")).toBe(11); // DEF: clean sheet + tackles + cross + passes
    expect(pointsOf("814590")).toBe(16.75); // FWD: 2 goals + shots + passes
    expect(pointsOf("859765")).toBe(2.25); // MID: shot + passes - missed pen
    expect(pointsOf("786028")).toBe(7.5); // MID: assist + passes
    expect(pointsOf("197428")).toBe(5.5); // GK: saves + pen save + passes - 3 conceded
    expect(pointsOf("94758")).toBe(1); // DEF: tackles + passes - own goal - yellow
    expect(pointsOf("20602")).toBe(-3.75); // MID: passes - red
  });
});
