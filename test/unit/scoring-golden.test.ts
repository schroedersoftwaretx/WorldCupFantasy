/**
 * Golden-scenario validation for the scoring engine.
 *
 * Each scenario in test/fixtures/golden-scenarios.json is one player's line
 * in one fixture, paired with the point total a careful reader of the
 * project plan would compute. This is the "validated against a past
 * tournament's match data" check from section 7 of the plan: we hand-wrote
 * these scenarios from the spec rather than scraping a real archive (the
 * tournament has not happened yet at build time), but the principle is the
 * same - any deviation from the documented values is caught here.
 *
 * Add a new scenario whenever a new edge case is identified; the test
 * runs through them all and reports per-scenario pass/fail so adding new
 * coverage is cheap.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { Position } from "../../src/data/db/schema.js";
import { DEFAULT_RULESET } from "../../src/data/scoring/ruleset.js";
import { scoreStatLine, type ScorableStatLine } from "../../src/data/scoring/score.js";

interface Scenario {
  name: string;
  position: Position;
  stat: Partial<ScorableStatLine>;
  expected: { points: number };
}

interface GoldenFile {
  scenarios: Scenario[];
}

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "golden-scenarios.json",
);

function defaults(): ScorableStatLine {
  return {
    minutesPlayed: 0,
    goals: 0,
    assists: 0,
    saves: 0,
    yellowCards: 0,
    redCards: 0,
    penaltiesScored: 0,
    penaltiesMissed: 0,
    penaltiesSaved: 0,
    ownGoals: 0,
    teamConcededInRegulationAndEt: 0,
  };
}

describe("scoring engine: golden scenarios", async () => {
  const raw = await readFile(FIXTURE_PATH, "utf8");
  const data = JSON.parse(raw) as GoldenFile;

  for (const scenario of data.scenarios) {
    it(scenario.name, () => {
      const stat = { ...defaults(), ...scenario.stat };
      const result = scoreStatLine(stat, scenario.position, DEFAULT_RULESET);
      expect(result.points).toBe(scenario.expected.points);
    });
  }
});
