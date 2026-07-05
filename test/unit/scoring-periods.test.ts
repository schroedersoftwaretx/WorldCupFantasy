/**
 * Unit tests for the Phase 9 scoring-period service: the stage-enum fallback
 * must reproduce the pre-Phase-9 period list exactly, and fixture->period
 * assignment must prefer scoring_period_id with a stage_code fallback.
 */
import { describe, expect, it } from "vitest";

import {
  assignFixturesToPeriods,
  stageFallbackPeriods,
} from "../../src/data/competition/periods.js";
import { stageEnum } from "../../src/data/db/schema.js";

describe("stageFallbackPeriods", () => {
  it("mirrors the stage enum in order with 1-based ordinals", () => {
    const periods = stageFallbackPeriods();
    expect(periods.map((p) => p.stageCode)).toEqual([...stageEnum.enumValues]);
    expect(periods.map((p) => p.ordinal)).toEqual(
      stageEnum.enumValues.map((_, i) => i + 1),
    );
    expect(periods.every((p) => p.id === null)).toBe(true);
  });
});

describe("assignFixturesToPeriods", () => {
  const periods = [
    { id: 11, ordinal: 1, label: "Group 1", stageCode: "GROUP_1" as const },
    { id: 12, ordinal: 2, label: "Group 2", stageCode: "GROUP_2" as const },
    { id: 13, ordinal: 9, label: "Final", stageCode: "FINAL" as const },
  ];

  it("assigns by scoring_period_id when set", () => {
    const map = assignFixturesToPeriods(periods, [
      { id: 1, stage: "GROUP_1", scoringPeriodId: 13 },
    ]);
    expect(map.get(1)).toBe(9); // the id wins over the stage
  });

  it("falls back to stage_code when scoring_period_id is null", () => {
    const map = assignFixturesToPeriods(periods, [
      { id: 2, stage: "GROUP_2", scoringPeriodId: null },
    ]);
    expect(map.get(2)).toBe(2);
  });

  it("falls back to stage_code when the id matches no period", () => {
    const map = assignFixturesToPeriods(periods, [
      { id: 3, stage: "FINAL", scoringPeriodId: 999 },
    ]);
    expect(map.get(3)).toBe(9);
  });

  it("leaves fixtures matching no period unassigned", () => {
    const map = assignFixturesToPeriods(periods, [
      { id: 4, stage: "QF", scoringPeriodId: null },
    ]);
    expect(map.has(4)).toBe(false);
  });

  it("enum-fallback periods assign by stage exactly like pre-Phase-9", () => {
    const fallback = stageFallbackPeriods();
    const map = assignFixturesToPeriods(fallback, [
      { id: 5, stage: "R16", scoringPeriodId: null },
      { id: 6, stage: "GROUP_3", scoringPeriodId: 42 }, // id unknown -> stage
    ]);
    expect(map.get(5)).toBe(stageEnum.enumValues.indexOf("R16") + 1);
    expect(map.get(6)).toBe(stageEnum.enumValues.indexOf("GROUP_3") + 1);
  });
});
