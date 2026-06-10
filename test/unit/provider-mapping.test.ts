/**
 * Unit tests for the api-sports.io → internal mapping helpers.
 *
 * These tests read the same JSON fixtures the FixtureMockProvider uses, so
 * they double as a check that the committed fixtures are well-formed.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  indexStandings,
  mapFixtureStats,
  mapFixtures,
  mapPosition,
  mapStage,
  mapSquads,
  mapFixtureStatus,
  type RawFixturePlayersResponse,
  type RawFixtureResponse,
  type RawSquadResponse,
  type RawStandingEntry,
} from "../../src/data/provider/api-football-mapping.js";
import { ProviderMappingError } from "../../src/data/provider/types.js";

const FIXTURES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "provider",
);

async function loadJson<T>(rel: string): Promise<T> {
  const buf = await readFile(resolve(FIXTURES_DIR, rel), "utf8");
  return JSON.parse(buf) as T;
}

describe("mapPosition", () => {
  it("maps the squads endpoint vocabulary", () => {
    expect(mapPosition("Goalkeeper")).toBe("GK");
    expect(mapPosition("Defender")).toBe("DEF");
    expect(mapPosition("Midfielder")).toBe("MID");
    expect(mapPosition("Attacker")).toBe("FWD");
  });

  it("maps the fixtures/players short codes", () => {
    expect(mapPosition("G")).toBe("GK");
    expect(mapPosition("D")).toBe("DEF");
    expect(mapPosition("M")).toBe("MID");
    expect(mapPosition("F")).toBe("FWD");
  });

  it("is whitespace and case insensitive", () => {
    expect(mapPosition("  defender  ")).toBe("DEF");
    expect(mapPosition("ATTACKER")).toBe("FWD");
  });

  it("throws ProviderMappingError on unknown input", () => {
    expect(() => mapPosition("Coach")).toThrow(ProviderMappingError);
    expect(() => mapPosition("")).toThrow(ProviderMappingError);
  });
});

describe("mapStage", () => {
  it("maps all canonical World Cup round labels", () => {
    expect(mapStage("Group Stage - 1")).toBe("GROUP_1");
    expect(mapStage("Group Stage - 2")).toBe("GROUP_2");
    expect(mapStage("Group Stage - 3")).toBe("GROUP_3");
    expect(mapStage("Round of 32")).toBe("R32");
    expect(mapStage("Round of 16")).toBe("R16");
    expect(mapStage("Quarter-finals")).toBe("QF");
    expect(mapStage("Semi-finals")).toBe("SF");
    expect(mapStage("3rd Place Final")).toBe("THIRD_PLACE");
    expect(mapStage("Final")).toBe("FINAL");
  });

  it("accepts common label variants", () => {
    expect(mapStage("quarterfinals")).toBe("QF");
    expect(mapStage("Semi Finals")).toBe("SF");
    expect(mapStage("Third Place Final")).toBe("THIRD_PLACE");
    // unicode en-dash should still work
    expect(mapStage("Quarter–finals")).toBe("QF");
  });

  it("throws on unknown round labels rather than mis-classifying", () => {
    expect(() => mapStage("Group Stage - 4")).toThrow(ProviderMappingError);
    expect(() => mapStage("Pre-final")).toThrow(ProviderMappingError);
  });
});

describe("mapFixtureStatus", () => {
  it("collapses provider short codes correctly", () => {
    expect(mapFixtureStatus("NS")).toBe("SCHEDULED");
    expect(mapFixtureStatus("TBD")).toBe("SCHEDULED");
    expect(mapFixtureStatus("PST")).toBe("SCHEDULED");
    expect(mapFixtureStatus("1H")).toBe("LIVE");
    expect(mapFixtureStatus("ET")).toBe("LIVE");
    expect(mapFixtureStatus("FT")).toBe("FINISHED");
    expect(mapFixtureStatus("AET")).toBe("FINISHED");
    expect(mapFixtureStatus("PEN")).toBe("FINISHED");
  });

  it("never silently marks unknown statuses as FINISHED", () => {
    expect(mapFixtureStatus("ZZZ")).toBe("SCHEDULED");
    expect(mapFixtureStatus(null)).toBe("SCHEDULED");
    expect(mapFixtureStatus(undefined)).toBe("SCHEDULED");
  });
});

describe("indexStandings", () => {
  it("extracts group letters from the provider's 'Group X' label", async () => {
    const standingsResp = await loadJson<{
      response: Array<{ league: { standings: RawStandingEntry[][] } }>;
    }>("standings.json");
    const flat = (standingsResp.response[0]?.league.standings ?? []).flat();
    const idx = indexStandings(flat);
    expect(idx.size).toBe(4);
    expect(idx.get("26")).toBe("A");
    expect(idx.get("6")).toBe("A");
    expect(idx.get("16")).toBe("A");
    expect(idx.get("2")).toBe("A");
  });

  it("returns null when the group label is missing or malformed", () => {
    const out = indexStandings([
      { team: { id: 1, name: "X" }, group: null },
      { team: { id: 2, name: "Y" }, group: "Not A Group" },
    ]);
    expect(out.get("1")).toBeNull();
    expect(out.get("2")).toBeNull();
  });
});

describe("mapSquads", () => {
  it("maps the committed squads + standings fixtures into ProviderSquads", async () => {
    const standings = await loadJson<{
      response: Array<{ league: { standings: RawStandingEntry[][] } }>;
    }>("standings.json");
    const squadsRaw = await loadJson<RawSquadResponse[]>("squads.json");
    const groupIndex = indexStandings(
      (standings.response[0]?.league.standings ?? []).flat(),
    );

    const squads = mapSquads(squadsRaw, groupIndex);
    expect(squads).toHaveLength(4);

    const argentina = squads.find((s) => s.team.sourceTeamId === "26");
    expect(argentina).toBeDefined();
    expect(argentina?.team.name).toBe("Argentina");
    expect(argentina?.team.groupLabel).toBe("A");
    expect(argentina?.players).toHaveLength(3);

    // Position mapping cascade: full names → enum.
    const positions = argentina!.players.map((p) => p.position).sort();
    expect(positions).toEqual(["DEF", "FWD", "GK"]);

    // Every player carries the team id so we can FK them later.
    for (const p of argentina!.players) {
      expect(p.sourceTeamId).toBe("26");
    }
  });
});

describe("mapFixtures", () => {
  it("maps the committed schedule into ProviderFixtures with correct stage / status", async () => {
    const raw = await loadJson<{ response: RawFixtureResponse[] }>("schedule.json");
    const fixtures = mapFixtures(raw.response);
    expect(fixtures).toHaveLength(6);

    const finished = fixtures.find((f) => f.sourceFixtureId === "8001");
    expect(finished).toBeDefined();
    expect(finished?.stage).toBe("GROUP_1");
    expect(finished?.status).toBe("FINISHED");
    expect(finished?.homeScore).toBe(2);
    expect(finished?.awayScore).toBe(1);

    // Pending matches keep scores null even if `goals` happens to have a value.
    const scheduled = fixtures.find((f) => f.sourceFixtureId === "8002");
    expect(scheduled?.status).toBe("SCHEDULED");
    expect(scheduled?.homeScore).toBeNull();
    expect(scheduled?.awayScore).toBeNull();

    // Every stage in the fixture file maps cleanly.
    const stages = new Set(fixtures.map((f) => f.stage));
    expect(stages).toEqual(new Set(["GROUP_1", "GROUP_2", "GROUP_3"]));

    // Kickoffs are real Date objects in UTC.
    expect(finished?.kickoffUtc.toISOString()).toBe("2026-06-11T18:00:00.000Z");
  });
});

describe("mapFixtureStats", () => {
  it("derives per-player stats with correct team-conceded values", async () => {
    const scheduleRaw = await loadJson<{ response: RawFixtureResponse[] }>(
      "schedule.json",
    );
    const playersRaw = await loadJson<{ response: RawFixturePlayersResponse[] }>(
      "fixture-stats/8001.json",
    );

    const fixtures = mapFixtures(scheduleRaw.response);
    const fixture = fixtures.find((f) => f.sourceFixtureId === "8001")!;

    const lines = mapFixtureStats(playersRaw.response, fixture, "rev-1");
    expect(lines).toHaveLength(6);

    // Index by player id for assertions.
    const byPid = new Map(lines.map((l) => [l.sourcePlayerId, l]));

    // Messi: 2 goals, 90 minutes, Argentina conceded 1 (Brazil's goal).
    const messi = byPid.get("1003")!;
    expect(messi.goals).toBe(2);
    expect(messi.minutesPlayed).toBe(90);
    expect(messi.teamConcededInRegulationAndEt).toBe(1);

    // Casemiro: scored Brazil's 1, played 75 mins. Brazil conceded 2.
    const casemiro = byPid.get("2002")!;
    expect(casemiro.goals).toBe(1);
    expect(casemiro.minutesPlayed).toBe(75);
    expect(casemiro.teamConcededInRegulationAndEt).toBe(2);

    // Argentina's GK: 4 saves, conceded 1.
    const martinez = byPid.get("1001")!;
    expect(martinez.saves).toBe(4);
    expect(martinez.teamConcededInRegulationAndEt).toBe(1);

    // Romero: yellow card.
    const romero = byPid.get("1002")!;
    expect(romero.yellowCards).toBe(1);
    expect(romero.redCards).toBe(0);

    // Vinícius: 1 assist, 0 goals, conceded 2.
    const vini = byPid.get("2003")!;
    expect(vini.assists).toBe(1);
    expect(vini.goals).toBe(0);
    expect(vini.teamConcededInRegulationAndEt).toBe(2);

    // Revision tag is preserved verbatim.
    for (const line of lines) expect(line.sourceRevision).toBe("rev-1");
  });

  it("derives the v2 detailed-action fields", async () => {
    const scheduleRaw = await loadJson<{ response: RawFixtureResponse[] }>(
      "schedule.json",
    );
    const playersRaw = await loadJson<{ response: RawFixturePlayersResponse[] }>(
      "fixture-stats/8001.json",
    );
    const fixture = mapFixtures(scheduleRaw.response).find(
      (f) => f.sourceFixtureId === "8001",
    )!;
    const byPid = new Map(
      mapFixtureStats(playersRaw.response, fixture, "rev-1").map((l) => [
        l.sourcePlayerId,
        l,
      ]),
    );

    // Messi: shots 5 total / 4 on -> 4 on-target, 1 off-target; tackles total
    // 1 -> 1 successful (proxy); passes 41 @ 82% -> 34 completed; no crosses;
    // Argentina (home) scored 2.
    const messi = byPid.get("1003")!;
    expect(messi.shotsOnTarget).toBe(4);
    expect(messi.shotsOffTarget).toBe(1);
    expect(messi.tacklesSuccessful).toBe(1);
    expect(messi.passesCompleted).toBe(34);
    expect(messi.crosses).toBe(0);
    expect(messi.teamScoredInRegulationAndEt).toBe(2);
    expect(messi.goalsConceded).toBe(0);

    // Martinez (GK): conceded 1, 25 completed passes (32 @ 78%), team scored 2.
    const martinez = byPid.get("1001")!;
    expect(martinez.goalsConceded).toBe(1);
    expect(martinez.passesCompleted).toBe(25);
    expect(martinez.teamScoredInRegulationAndEt).toBe(2);

    // Casemiro (Brazil, away): team scored 1.
    const casemiro = byPid.get("2002")!;
    expect(casemiro.teamScoredInRegulationAndEt).toBe(1);
  });

  it("throws if a player's team isn't one of the fixture's teams", async () => {
    const scheduleRaw = await loadJson<{ response: RawFixtureResponse[] }>(
      "schedule.json",
    );
    const fixtures = mapFixtures(scheduleRaw.response);
    const fixture = fixtures.find((f) => f.sourceFixtureId === "8001")!;

    const bogus: RawFixturePlayersResponse[] = [
      {
        team: { id: 9999 },
        players: [
          {
            player: { id: 1, name: "Unknown" },
            statistics: [
              {
                games: { minutes: 90 },
                goals: { total: 0, conceded: 0, assists: 0, saves: 0 },
                cards: { yellow: 0, red: 0 },
                penalty: { scored: 0, missed: 0, saved: 0 },
              },
            ],
          },
        ],
      },
    ];

    expect(() => mapFixtureStats(bogus, fixture, "rev-1")).toThrow(ProviderMappingError);
  });
});
