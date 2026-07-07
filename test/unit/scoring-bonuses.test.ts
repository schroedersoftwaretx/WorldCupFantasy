/**
 * Phase-07 7.2 bonus scoring. The #1 invariant: a ruleset WITHOUT a
 * `bonuses` block - i.e. every existing league - hashes and scores
 * byte-identically to before this feature existed.
 */
import { describe, expect, it } from "vitest";

import { computeStreakSet } from "../../src/data/scoring/recompute.js";
import {
  buildRuleset,
  DEFAULT_RULESET,
  RulesetValidationError,
  sanitizeRulesetInput,
  type RulesetBonuses,
} from "../../src/data/scoring/ruleset.js";
import { scoreStatLine, type ScorableStatLine } from "../../src/data/scoring/score.js";

const BONUSES: RulesetBonuses = {
  brace: 3,
  hatTrick: 8,
  stageMultipliers: { FINAL: 2 },
  scoringStreak: { length: 3, bonus: 2 },
};

function stat(overrides: Partial<ScorableStatLine> = {}): ScorableStatLine {
  return {
    minutesPlayed: 90,
    goals: 0,
    assists: 0,
    saves: 0,
    yellowCards: 0,
    redCards: 0,
    penaltiesScored: 0,
    penaltiesMissed: 0,
    penaltiesSaved: 0,
    ownGoals: 0,
    teamConcededInRegulationAndEt: 1,
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

const WITH_BONUSES = buildRuleset({ ...DEFAULT_RULESET, bonuses: BONUSES });

describe("ruleset hash invariants", () => {
  it("the default ruleset version is unchanged by the bonuses feature", () => {
    // Pinned to the value the live DB uses (set by commit 94ca8e3 "rule
    // schema"). If this fails, existing leagues would need repointing.
    expect(DEFAULT_RULESET.version).toBe("wcf-v1-a00a7fcf");
    expect("bonuses" in DEFAULT_RULESET).toBe(false);
  });

  it("adding a bonuses block produces a NEW version", () => {
    expect(WITH_BONUSES.version).not.toBe(DEFAULT_RULESET.version);
    // Deterministic: same block -> same version.
    expect(buildRuleset({ ...DEFAULT_RULESET, bonuses: BONUSES }).version).toBe(
      WITH_BONUSES.version,
    );
  });
});

describe("scoreStatLine with bonuses", () => {
  it("no-bonus rulesets ignore the context and add no breakdown keys", () => {
    const plain = scoreStatLine(stat({ goals: 3 }), "FWD", DEFAULT_RULESET, {
      stage: "FINAL",
      streakQualified: true,
    });
    const before = scoreStatLine(stat({ goals: 3 }), "FWD", DEFAULT_RULESET);
    expect(plain).toEqual(before);
    expect("bonus" in plain.breakdown).toBe(false);
    expect("stageMultiplier" in plain.breakdown).toBe(false);
  });

  it("pays a brace bonus for exactly two goals", () => {
    const two = scoreStatLine(stat({ goals: 2 }), "FWD", WITH_BONUSES, {
      stage: "GROUP_1",
    });
    // appearance 1 + 60' 1 + 2 goals x5 + brace 3 = 15.
    expect(two.points).toBe(15);
    expect(two.breakdown.bonus).toBe(3);
  });

  it("pays the hat-trick bonus instead of the brace for 3+", () => {
    const three = scoreStatLine(stat({ goals: 3 }), "FWD", WITH_BONUSES, {
      stage: "GROUP_1",
    });
    // 1 + 1 + 15 + 8 = 25.
    expect(three.points).toBe(25);
    expect(three.breakdown.bonus).toBe(8);
  });

  it("adds the streak bonus when the context says so", () => {
    const r = scoreStatLine(stat({ goals: 1 }), "FWD", WITH_BONUSES, {
      stage: "GROUP_1",
      streakQualified: true,
    });
    // 1 + 1 + 5 + streak 2 = 9.
    expect(r.points).toBe(9);
    expect(r.breakdown.bonus).toBe(2);
  });

  it("multiplies the whole score (including bonuses) on mapped stages", () => {
    const final = scoreStatLine(stat({ goals: 2 }), "FWD", WITH_BONUSES, {
      stage: "FINAL",
    });
    // (1 + 1 + 10 + 3) x2 = 30.
    expect(final.points).toBe(30);
    expect(final.breakdown.stageMultiplier).toBe(2);
    // Unmapped stage: multiplier key absent.
    const group = scoreStatLine(stat({ goals: 2 }), "FWD", WITH_BONUSES, {
      stage: "GROUP_1",
    });
    expect("stageMultiplier" in group.breakdown).toBe(false);
  });
});

describe("computeStreakSet", () => {
  const row = (
    fixtureId: number,
    goals: number,
    minutes = 90,
    day = fixtureId,
  ) => ({
    playerId: 1,
    fixtureId,
    goals,
    minutesPlayed: minutes,
    kickoffUtc: new Date(Date.UTC(2026, 5, day)),
  });

  it("qualifies from the Nth consecutive scoring match onward", () => {
    const set = computeStreakSet(
      [row(1, 1), row(2, 1), row(3, 1), row(4, 1)],
      3,
    );
    expect(set).toEqual(new Set(["1:3", "1:4"]));
  });

  it("a scoreless played match resets; a bench match is skipped", () => {
    const set = computeStreakSet(
      [
        row(1, 1),
        row(2, 1),
        row(3, 0), // played, no goal -> reset
        row(4, 1),
        row(5, 2, 0), // bench (0 minutes) -> skipped entirely
        row(6, 1),
        row(7, 1),
      ],
      3,
    );
    expect(set).toEqual(new Set(["1:7"]));
  });
});

describe("sanitizeRulesetInput bonuses", () => {
  const base = JSON.parse(JSON.stringify(DEFAULT_RULESET)) as Record<string, unknown>;

  it("omits bonuses when absent and preserves the default hash", () => {
    const values = sanitizeRulesetInput(base);
    expect("bonuses" in values).toBe(false);
    expect(buildRuleset(values).version).toBe(DEFAULT_RULESET.version);
  });

  it("accepts a valid bonuses block", () => {
    const values = sanitizeRulesetInput({ ...base, bonuses: BONUSES });
    expect(values.bonuses).toEqual(BONUSES);
    expect(buildRuleset(values).version).toBe(WITH_BONUSES.version);
  });

  it("rejects bad multipliers, unknown stages and 1-match streaks", () => {
    expect(() =>
      sanitizeRulesetInput({
        ...base,
        bonuses: { ...BONUSES, stageMultipliers: { FINAL: 11 } },
      }),
    ).toThrowError(RulesetValidationError);
    expect(() =>
      sanitizeRulesetInput({
        ...base,
        bonuses: { ...BONUSES, stageMultipliers: { NOT_A_STAGE: 2 } },
      }),
    ).toThrowError(RulesetValidationError);
    expect(() =>
      sanitizeRulesetInput({
        ...base,
        bonuses: { ...BONUSES, scoringStreak: { length: 1, bonus: 2 } },
      }),
    ).toThrowError(RulesetValidationError);
  });
});
