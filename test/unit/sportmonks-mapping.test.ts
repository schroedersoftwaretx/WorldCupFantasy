/**
 * Unit tests for the Sportmonks v3 mapping.
 *
 * Drives the pure mapper against a committed fixture payload shaped like the
 * real `/fixtures/{id}?include=...lineups.details.type` response, then runs the
 * mapped lines through the scoring engine. This is the offline guarantee that
 * crosses / accurate passes / tackles / shots flow all the way to points.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { Position } from "../../src/data/db/schema.js";
import {
  mapSmFixtureStats,
  mapSmStage,
  mapSmStatus,
  smRegEtScore,
  type SmFixtureDetail,
} from "../../src/data/provider/sportmonks-mapping.js";
import { DEFAULT_RULESET } from "../../src/data/scoring/ruleset.js";
import { scoreStatLine, type ScorableStatLine } from "../../src/data/scoring/score.js";

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "sportmonks",
  "fixture-8001.json",
);

async function loadFixture(): Promise<SmFixtureDetail> {
  const raw = JSON.parse(await readFile(FIXTURE, "utf8")) as { data: SmFixtureDetail };
  return raw.data;
}

describe("mapSmStage", () => {
  it("maps group matchdays from the round number", () => {
    expect(mapSmStage("Group Stage", "1")).toBe("GROUP_1");
    expect(mapSmStage("Group Stage", "2")).toBe("GROUP_2");
    expect(mapSmStage("Group Stage", "3")).toBe("GROUP_3");
  });
  it("maps knockout stages from the stage name", () => {
    expect(mapSmStage("Round of 32", null)).toBe("R32");
    expect(mapSmStage("Round of 16", null)).toBe("R16");
    expect(mapSmStage("Quarter-finals", null)).toBe("QF");
    expect(mapSmStage("Semi-finals", null)).toBe("SF");
    expect(mapSmStage("3rd Place Final", null)).toBe("THIRD_PLACE");
    expect(mapSmStage("Final", null)).toBe("FINAL");
  });
  it("throws on an unrecognised stage", () => {
    expect(() => mapSmStage("Mystery Cup", null)).toThrow();
  });
});

describe("mapSmStatus + smRegEtScore", () => {
  it("treats FT as finished and reads the CURRENT score (excludes shootout)", () => {
    expect(mapSmStatus({ short_name: "FT" })).toBe("FINISHED");
    expect(mapSmStatus({ short_name: "NS" })).toBe("SCHEDULED");
    expect(
      smRegEtScore([
        { description: "CURRENT", score: { participant: "home", goals: 2 } },
        { description: "CURRENT", score: { participant: "away", goals: 1 } },
        { description: "PENALTY_SHOOTOUT", score: { participant: "home", goals: 4 } },
      ]),
    ).toEqual({ home: 2, away: 1 });
  });
});

describe("mapSmFixtureStats", () => {
  it("maps the detailed per-player fields", async () => {
    const fx = await loadFixture();
    const lines = mapSmFixtureStats(fx, "rev-1");
    expect(lines).toHaveLength(6);
    const by = new Map(lines.map((l) => [l.sourcePlayerId, l]));

    const martinez = by.get("9001")!;
    expect(martinez.saves).toBe(4);
    expect(martinez.goalsConceded).toBe(1);
    expect(martinez.passesCompleted).toBe(25);
    expect(martinez.teamScoredInRegulationAndEt).toBe(2);
    expect(martinez.teamConcededInRegulationAndEt).toBe(1);

    const romero = by.get("9002")!;
    expect(romero.tacklesSuccessful).toBe(4);
    expect(romero.crosses).toBe(2);
    expect(romero.passesCompleted).toBe(50);
    expect(romero.yellowCards).toBe(1);
    expect(romero.shotsOffTarget).toBe(1);

    const messi = by.get("9003")!;
    expect(messi.goals).toBe(2);
    expect(messi.shotsOnTarget).toBe(4);
    expect(messi.crosses).toBe(3);
    expect(messi.passesCompleted).toBe(34);

    const vini = by.get("9006")!;
    expect(vini.assists).toBe(1);
    expect(vini.crosses).toBe(5);
    expect(vini.teamScoredInRegulationAndEt).toBe(1);
    expect(vini.teamConcededInRegulationAndEt).toBe(2);
  });

  it("scores the mapped lines end-to-end", async () => {
    const fx = await loadFixture();
    const by = new Map(mapSmFixtureStats(fx, "rev-1").map((l) => [l.sourcePlayerId, l]));
    const pos: Record<string, Position> = {
      "9001": "GK",
      "9002": "DEF",
      "9003": "FWD",
      "9004": "GK",
      "9005": "MID",
      "9006": "FWD",
    };
    const pointsOf = (id: string) =>
      scoreStatLine(by.get(id)! as ScorableStatLine, pos[id]!, DEFAULT_RULESET).points;

    expect(pointsOf("9001")).toBe(11.25); // GK: +saves +passes -1 conceded +5 win
    expect(pointsOf("9002")).toBe(7); // DEF: tackles + cross + passes - yellow
    expect(pointsOf("9003")).toBe(18.2); // FWD: 2 goals + shots + cross + passes
    expect(pointsOf("9004")).toBe(4); // GK: saves + passes - 2 conceded, no win
    expect(pointsOf("9005")).toBe(14); // MID: goal + shots + tackles + passes
    expect(pointsOf("9006")).toBe(12.75); // FWD: assist + shots + cross + passes
  });
});
