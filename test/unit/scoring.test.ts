/**
 * Per-rule unit tests for the scoring function.
 *
 * Each test isolates a single scoring rule against the DEFAULT_RULESET so
 * we can pin down the contribution of every clause in section 5.1 / 5.2.
 */
import { describe, expect, it } from "vitest";

import type { Position } from "../../src/data/db/schema.js";
import { DEFAULT_RULESET, buildRuleset } from "../../src/data/scoring/ruleset.js";
import { scoreStatLine, type ScorableStatLine } from "../../src/data/scoring/score.js";

function makeStat(overrides: Partial<ScorableStatLine> = {}): ScorableStatLine {
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
    teamScoredInRegulationAndEt: 0,
    shotsOnTarget: 0,
    shotsOffTarget: 0,
    tacklesSuccessful: 0,
    crosses: 0,
    passesCompleted: 0,
    keyPasses: 0,
    bigChancesCreated: 0,
    goalsConceded: 0,
    ...overrides,
  };
}

describe("scoreStatLine: appearance + minutes", () => {
  it("zero minutes -> zero points across the board", () => {
    const res = scoreStatLine(makeStat({ goals: 1, assists: 1 }), "FWD", DEFAULT_RULESET);
    expect(res.points).toBe(0);
    expect(res.breakdown.appearance).toBe(0);
    expect(res.breakdown.played60Plus).toBe(0);
    expect(res.breakdown.goals).toBe(0);
  });

  it("any minutes earns the appearance point", () => {
    const res = scoreStatLine(makeStat({ minutesPlayed: 1 }), "MID", DEFAULT_RULESET);
    expect(res.breakdown.appearance).toBe(1);
    expect(res.breakdown.played60Plus).toBe(0);
    expect(res.points).toBe(1);
  });

  // MID below so the default-zero conceded count does not also grant a clean sheet.
  it("59 minutes does not earn the 60+ bonus", () => {
    const res = scoreStatLine(makeStat({ minutesPlayed: 59 }), "MID", DEFAULT_RULESET);
    expect(res.breakdown.played60Plus).toBe(0);
    expect(res.points).toBe(1);
  });

  it("exactly 60 minutes earns the 60+ bonus", () => {
    const res = scoreStatLine(makeStat({ minutesPlayed: 60 }), "MID", DEFAULT_RULESET);
    expect(res.breakdown.appearance).toBe(1);
    expect(res.breakdown.played60Plus).toBe(1);
    expect(res.points).toBe(2);
  });

  it("90 minutes also earns the 60+ bonus", () => {
    const res = scoreStatLine(makeStat({ minutesPlayed: 90 }), "MID", DEFAULT_RULESET);
    expect(res.breakdown.played60Plus).toBe(1);
  });
});

describe("scoreStatLine: goals scale by position", () => {
  const cases: Array<{ pos: Position; expected: number }> = [
    { pos: "GK", expected: 12 },
    { pos: "DEF", expected: 7 },
    { pos: "MID", expected: 6 },
    { pos: "FWD", expected: 5 },
  ];
  for (const { pos, expected } of cases) {
    it(`${pos} scores ${expected} per goal`, () => {
      const res = scoreStatLine(
        makeStat({ minutesPlayed: 90, goals: 1, teamConcededInRegulationAndEt: 1 }),
        pos,
        DEFAULT_RULESET,
      );
      expect(res.breakdown.goals).toBe(expected);
    });
  }

  it("two goals scales linearly", () => {
    const res = scoreStatLine(
      makeStat({ minutesPlayed: 90, goals: 2, teamConcededInRegulationAndEt: 1 }),
      "FWD",
      DEFAULT_RULESET,
    );
    expect(res.breakdown.goals).toBe(10);
  });
});

describe("scoreStatLine: assists, saves, penalties saved", () => {
  it("assists score +4 regardless of position", () => {
    const a = scoreStatLine(makeStat({ minutesPlayed: 90, assists: 1, teamConcededInRegulationAndEt: 1 }), "GK", DEFAULT_RULESET);
    const b = scoreStatLine(makeStat({ minutesPlayed: 90, assists: 1, teamConcededInRegulationAndEt: 1 }), "FWD", DEFAULT_RULESET);
    expect(a.breakdown.assists).toBe(4);
    expect(b.breakdown.assists).toBe(4);
  });

  it("each save is +1", () => {
    const res = scoreStatLine(
      makeStat({ minutesPlayed: 90, saves: 7, teamConcededInRegulationAndEt: 2 }),
      "GK",
      DEFAULT_RULESET,
    );
    expect(res.breakdown.saves).toBe(7);
  });

  it("penalty saved is +2", () => {
    const res = scoreStatLine(
      makeStat({ minutesPlayed: 90, penaltiesSaved: 1, teamConcededInRegulationAndEt: 1 }),
      "GK",
      DEFAULT_RULESET,
    );
    expect(res.breakdown.penaltiesSaved).toBe(2);
  });
});

describe("scoreStatLine: clean sheet edge cases (section 5.2)", () => {
  it("GK on the pitch for 60+ with 0 conceded -> +5", () => {
    const res = scoreStatLine(
      makeStat({ minutesPlayed: 90, saves: 0, teamConcededInRegulationAndEt: 0 }),
      "GK",
      DEFAULT_RULESET,
    );
    expect(res.breakdown.cleanSheet).toBe(5);
  });

  it("DEF on the pitch for 60+ with 0 conceded -> +5", () => {
    const res = scoreStatLine(
      makeStat({ minutesPlayed: 90, teamConcededInRegulationAndEt: 0 }),
      "DEF",
      DEFAULT_RULESET,
    );
    expect(res.breakdown.cleanSheet).toBe(5);
  });

  it("MID does NOT earn a clean sheet even with 0 conceded", () => {
    const res = scoreStatLine(
      makeStat({ minutesPlayed: 90, teamConcededInRegulationAndEt: 0 }),
      "MID",
      DEFAULT_RULESET,
    );
    expect(res.breakdown.cleanSheet).toBe(0);
  });

  it("FWD does NOT earn a clean sheet", () => {
    const res = scoreStatLine(
      makeStat({ minutesPlayed: 90, teamConcededInRegulationAndEt: 0 }),
      "FWD",
      DEFAULT_RULESET,
    );
    expect(res.breakdown.cleanSheet).toBe(0);
  });

  it("DEF subbed at 55' with score still 0-0 does NOT earn it", () => {
    const res = scoreStatLine(
      makeStat({ minutesPlayed: 55, teamConcededInRegulationAndEt: 0 }),
      "DEF",
      DEFAULT_RULESET,
    );
    expect(res.breakdown.cleanSheet).toBe(0);
  });

  it("DEF played 90 but team conceded 1 -> no clean sheet", () => {
    const res = scoreStatLine(
      makeStat({ minutesPlayed: 90, teamConcededInRegulationAndEt: 1 }),
      "DEF",
      DEFAULT_RULESET,
    );
    expect(res.breakdown.cleanSheet).toBe(0);
  });

  it("GK sent off before 60' does NOT earn a clean sheet", () => {
    const res = scoreStatLine(
      makeStat({
        minutesPlayed: 45,
        redCards: 1,
        teamConcededInRegulationAndEt: 0,
      }),
      "GK",
      DEFAULT_RULESET,
    );
    expect(res.breakdown.cleanSheet).toBe(0);
  });
});

describe("scoreStatLine: deductions", () => {
  it("yellow card -1", () => {
    const res = scoreStatLine(
      makeStat({ minutesPlayed: 90, yellowCards: 1, teamConcededInRegulationAndEt: 1 }),
      "MID",
      DEFAULT_RULESET,
    );
    expect(res.breakdown.yellowCards).toBe(-1);
  });

  it("two yellows + red counts per-type, not escalating", () => {
    const res = scoreStatLine(
      makeStat({ minutesPlayed: 67, yellowCards: 2, redCards: 1, teamConcededInRegulationAndEt: 1 }),
      "MID",
      DEFAULT_RULESET,
    );
    expect(res.breakdown.yellowCards).toBe(-2);
    expect(res.breakdown.redCards).toBe(-5);
    // appearance +1, 60+ +1, two yellows -2, red -5 -> -5 total
    expect(res.points).toBe(-5);
  });

  it("own goal -2", () => {
    const res = scoreStatLine(
      makeStat({ minutesPlayed: 90, ownGoals: 1, teamConcededInRegulationAndEt: 1 }),
      "DEF",
      DEFAULT_RULESET,
    );
    expect(res.breakdown.ownGoals).toBe(-2);
  });

  it("penalty missed -2", () => {
    const res = scoreStatLine(
      makeStat({ minutesPlayed: 90, penaltiesMissed: 1, teamConcededInRegulationAndEt: 1 }),
      "FWD",
      DEFAULT_RULESET,
    );
    expect(res.breakdown.penaltiesMissed).toBe(-2);
  });

  it("red card -5", () => {
    const res = scoreStatLine(
      makeStat({ minutesPlayed: 75, redCards: 1, teamConcededInRegulationAndEt: 1 }),
      "DEF",
      DEFAULT_RULESET,
    );
    expect(res.breakdown.redCards).toBe(-5);
  });
});

describe("scoreStatLine: playmaking", () => {
  it("rewards big chances created at +2 each", () => {
    const res = scoreStatLine(
      makeStat({ minutesPlayed: 90, bigChancesCreated: 3, teamConcededInRegulationAndEt: 1 }),
      "MID",
      DEFAULT_RULESET,
    );
    expect(res.breakdown.bigChancesCreated).toBe(6);
    // 1 (appearance) + 1 (60+) + 6 (3 big chances) = 8
    expect(res.points).toBe(8);
  });

  it("rewards key passes at +0.5 each", () => {
    const res = scoreStatLine(
      makeStat({ minutesPlayed: 90, keyPasses: 5, teamConcededInRegulationAndEt: 1 }),
      "MID",
      DEFAULT_RULESET,
    );
    expect(res.breakdown.keyPasses).toBe(2.5);
    // 1 + 1 + 2.5 = 4.5
    expect(res.points).toBe(4.5);
  });

  it("a converted big chance pays the assist only, not the big-chance bonus", () => {
    // 1 assist that was also a big chance: assist +4, big-chance bonus removed.
    const res = scoreStatLine(
      makeStat({
        minutesPlayed: 90,
        assists: 1,
        bigChancesCreated: 1,
        teamConcededInRegulationAndEt: 1,
      }),
      "MID",
      DEFAULT_RULESET,
    );
    expect(res.breakdown.assists).toBe(4);
    expect(res.breakdown.bigChancesCreated).toBe(0);
    // 1 + 1 + 4 = 6
    expect(res.points).toBe(6);
  });

  it("an unconverted big chance that was a key pass pays the bonus only, not both", () => {
    // 1 key pass that was also a big chance: +2 (big chance), key pass removed.
    const res = scoreStatLine(
      makeStat({
        minutesPlayed: 90,
        keyPasses: 1,
        bigChancesCreated: 1,
        teamConcededInRegulationAndEt: 1,
      }),
      "MID",
      DEFAULT_RULESET,
    );
    expect(res.breakdown.bigChancesCreated).toBe(2);
    expect(res.breakdown.keyPasses).toBe(0);
    // 1 + 1 + 2 = 4 (NOT 4.5)
    expect(res.points).toBe(4);
  });

  it("de-dups assist > big chance > key pass across mixed counts", () => {
    // assists 1, bigChances 2, keyPasses 3:
    //   effectiveBig = max(0, 2 - 1) = 1  -> +2
    //   effectiveKey = max(0, 3 - 1) = 2  -> +1.0
    // 1 + 1 + (1*6 goal) + (1*4 assist) + 2 + 1.0 = 15
    const res = scoreStatLine(
      makeStat({
        minutesPlayed: 90,
        goals: 1,
        assists: 1,
        keyPasses: 3,
        bigChancesCreated: 2,
        teamConcededInRegulationAndEt: 1,
      }),
      "MID",
      DEFAULT_RULESET,
    );
    expect(res.breakdown.bigChancesCreated).toBe(2);
    expect(res.breakdown.keyPasses).toBe(1);
    expect(res.points).toBe(15);
  });
});

describe("scoreStatLine: full composition", () => {
  it("rewards a brace + clean sheet for a defender", () => {
    // 90 mins, 2 goals, 1 yellow, team conceded 0:
    // 1 + 1 + (2*7) + (-1) + 5 = 20
    const res = scoreStatLine(
      makeStat({
        minutesPlayed: 90,
        goals: 2,
        yellowCards: 1,
        teamConcededInRegulationAndEt: 0,
      }),
      "DEF",
      DEFAULT_RULESET,
    );
    expect(res.points).toBe(20);
  });

  it("scores a heroic GK performance: 90', CS, penalty saved, 6 saves", () => {
    // 1 + 1 + 5(CS) + 2(pen saved) + 6(saves) = 15
    const res = scoreStatLine(
      makeStat({
        minutesPlayed: 90,
        saves: 6,
        penaltiesSaved: 1,
        teamConcededInRegulationAndEt: 0,
      }),
      "GK",
      DEFAULT_RULESET,
    );
    expect(res.points).toBe(15);
  });
});

describe("ruleset version stability", () => {
  it("two structurally identical rulesets produce the same version", () => {
    // Rebuild from the default's own values (minus its version) and confirm
    // the content-hash reproduces — determinism, independent of exact values.
    const { version, ...values } = DEFAULT_RULESET;
    const a = buildRuleset(values);
    expect(a.version).toBe(version);
  });

  it("any change to a point value yields a new version (incl. nested maps)", () => {
    // Regression guard: goalByPosition / cleanSheetByPosition are nested maps.
    // An earlier hash bug fed Object.keys(values).sort() as JSON.stringify's
    // allowlist arg, which dropped every nested key, so goal/clean-sheet
    // changes silently kept the same version. Each tweak below must produce a
    // distinct version, and all three must differ from each other.
    const goalTweak = buildRuleset({
      ...DEFAULT_RULESET,
      goalByPosition: { ...DEFAULT_RULESET.goalByPosition, FWD: 50 },
    });
    const cleanSheetTweak = buildRuleset({
      ...DEFAULT_RULESET,
      cleanSheetByPosition: { ...DEFAULT_RULESET.cleanSheetByPosition, DEF: 9 },
    });
    const scalarTweak = buildRuleset({ ...DEFAULT_RULESET, assist: 99 });
    expect(goalTweak.version).not.toBe(DEFAULT_RULESET.version);
    expect(cleanSheetTweak.version).not.toBe(DEFAULT_RULESET.version);
    expect(scalarTweak.version).not.toBe(DEFAULT_RULESET.version);
    expect(
      new Set([goalTweak.version, cleanSheetTweak.version, scalarTweak.version]).size,
    ).toBe(3);
  });

  it("ignores an incoming version field when hashing", () => {
    // buildRuleset must recompute the version, not trust a spread-in one, so
    // `{ ...DEFAULT_RULESET }` (which carries a version) round-trips cleanly.
    const rebuilt = buildRuleset({ ...DEFAULT_RULESET });
    expect(rebuilt.version).toBe(DEFAULT_RULESET.version);
  });
});
