/**
 * Unit tests for the pure "yet to play" core (current-stage selection and the
 * set of national teams with an unfinished current-stage fixture). Mirrors the
 * style of the standings/lineup unit tests: no DB, just the pure functions.
 */
import { describe, expect, it } from "vitest";

import {
  computeCurrentStage,
  computeYetToPlayState,
  type YetToPlayFixture,
} from "../../src/web/yet-to-play.js";

/** Build a fixture slice with sensible defaults. */
function fx(
  partial: Partial<YetToPlayFixture> & { stage: YetToPlayFixture["stage"] },
): YetToPlayFixture {
  return {
    status: "SCHEDULED",
    homeTeamId: 1,
    awayTeamId: 2,
    ...partial,
  };
}

describe("computeCurrentStage", () => {
  it("defaults to GROUP_1 before any fixtures exist", () => {
    expect(computeCurrentStage([])).toBe("GROUP_1");
  });

  it("returns GROUP_1 pre-tournament when all fixtures are scheduled", () => {
    const fixtures = [
      fx({ stage: "GROUP_1", status: "SCHEDULED" }),
      fx({ stage: "GROUP_2", status: "SCHEDULED" }),
    ];
    expect(computeCurrentStage(fixtures)).toBe("GROUP_1");
  });

  it("returns the earliest stage with an unfinished fixture (mid-round)", () => {
    // G1 fully finished, R32 has one LIVE and one scheduled -> current = R32.
    const fixtures = [
      fx({ stage: "GROUP_1", status: "FINISHED" }),
      fx({ stage: "GROUP_2", status: "FINISHED" }),
      fx({ stage: "GROUP_3", status: "FINISHED" }),
      fx({ stage: "R32", status: "LIVE" }),
      fx({ stage: "R32", status: "SCHEDULED" }),
      fx({ stage: "R16", status: "SCHEDULED" }),
    ];
    expect(computeCurrentStage(fixtures)).toBe("R32");
  });

  it("treats a partially played stage as current via its scheduled fixture", () => {
    const fixtures = [
      fx({ stage: "GROUP_1", status: "FINISHED" }),
      fx({ stage: "GROUP_1", status: "SCHEDULED" }),
    ];
    expect(computeCurrentStage(fixtures)).toBe("GROUP_1");
  });

  it("falls back to the latest stage with any fixture when all finished", () => {
    const fixtures = [
      fx({ stage: "GROUP_1", status: "FINISHED" }),
      fx({ stage: "QF", status: "FINISHED" }),
      fx({ stage: "FINAL", status: "FINISHED" }),
    ];
    expect(computeCurrentStage(fixtures)).toBe("FINAL");
  });
});

describe("computeYetToPlayState", () => {
  it("is inactive (bar hidden) once the current stage is fully finished", () => {
    const fixtures = [
      fx({ stage: "GROUP_1", status: "FINISHED" }),
      fx({ stage: "FINAL", status: "FINISHED" }),
    ];
    const state = computeYetToPlayState(fixtures);
    expect(state.currentStage).toBe("FINAL");
    expect(state.active).toBe(false);
    expect(state.pendingTeamIds.size).toBe(0);
  });

  it("collects only the nations with an unfinished fixture in the current stage", () => {
    // Current stage is R32. Teams 10/11 are still to play (SCHEDULED/LIVE);
    // teams 12/13 already finished their R32 tie; team 14 is a later stage.
    const fixtures = [
      fx({ stage: "GROUP_1", status: "FINISHED", homeTeamId: 1, awayTeamId: 2 }),
      fx({ stage: "R32", status: "SCHEDULED", homeTeamId: 10, awayTeamId: 11 }),
      fx({ stage: "R32", status: "FINISHED", homeTeamId: 12, awayTeamId: 13 }),
      fx({ stage: "R16", status: "SCHEDULED", homeTeamId: 14, awayTeamId: 15 }),
    ];
    const state = computeYetToPlayState(fixtures);
    expect(state.currentStage).toBe("R32");
    expect(state.active).toBe(true);
    expect([...state.pendingTeamIds].sort((a, b) => a - b)).toEqual([10, 11]);
    expect(state.pendingTeamIds.has(12)).toBe(false);
    expect(state.pendingTeamIds.has(14)).toBe(false);
  });

  it("counts every nation in GROUP_1 as pending pre-tournament", () => {
    const fixtures = [
      fx({ stage: "GROUP_1", status: "SCHEDULED", homeTeamId: 1, awayTeamId: 2 }),
      fx({ stage: "GROUP_1", status: "SCHEDULED", homeTeamId: 3, awayTeamId: 4 }),
    ];
    const state = computeYetToPlayState(fixtures);
    expect(state.currentStage).toBe("GROUP_1");
    expect(state.active).toBe(true);
    expect([...state.pendingTeamIds].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4,
    ]);
  });
});
