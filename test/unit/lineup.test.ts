/**
 * Unit tests for the SET_LINEUP building blocks (Phase 9 Priority 1):
 * XI validation, lineup roll-forward, and captain/vice period scoring.
 */
import { describe, expect, it } from "vitest";

import type { LineupRow, Position } from "../../src/data/db/schema.js";
import { LineupError } from "../../src/data/lineup/errors.js";
import {
  effectiveLineupForOrdinal,
  validateLineupSelection,
} from "../../src/data/lineup/service.js";
import { FORMATION_SETS } from "../../src/data/standings/lineup.js";
import {
  scoreSetLineupPeriod,
  type SetLineupSlotInput,
} from "../../src/data/standings/set-lineup.js";

/** Roster: ids 1 GK x2, 10+ DEF, MID, FWD to build any formation. */
function roster(): Map<number, Position> {
  const m = new Map<number, Position>();
  m.set(1, "GK");
  m.set(2, "GK");
  for (let i = 10; i < 18; i += 1) m.set(i, "DEF"); // 10..17
  for (let i = 20; i < 28; i += 1) m.set(i, "MID"); // 20..27
  for (let i = 30; i < 35; i += 1) m.set(i, "FWD"); // 30..34
  return m;
}

/** A legal 4-3-3: GK 1, DEF 10-13, MID 20-22, FWD 30-32. */
const XI_433 = [1, 10, 11, 12, 13, 20, 21, 22, 30, 31, 32];

function code(fn: () => unknown): string {
  try {
    fn();
    return "NO_ERROR";
  } catch (e) {
    return e instanceof LineupError ? e.code : "WRONG_TYPE";
  }
}

describe("validateLineupSelection", () => {
  it("accepts a legal 4-3-3 and returns its formation", () => {
    const f = validateLineupSelection(roster(), XI_433, 1, 30);
    expect(f).toEqual({ GK: 1, DEF: 4, MID: 3, FWD: 3 });
  });

  it("rejects the wrong XI size", () => {
    expect(code(() => validateLineupSelection(roster(), XI_433.slice(0, 10), 1, null))).toBe(
      "LINEUP_SIZE",
    );
  });

  it("rejects duplicates", () => {
    const dup = [...XI_433.slice(0, 10), 10];
    expect(code(() => validateLineupSelection(roster(), dup, 1, null))).toBe(
      "LINEUP_DUPLICATE_PLAYER",
    );
  });

  it("rejects players not on the roster", () => {
    const off = [...XI_433.slice(0, 10), 999];
    expect(code(() => validateLineupSelection(roster(), off, 1, null))).toBe(
      "PLAYER_NOT_ON_ROSTER",
    );
  });

  it("accepts a 3-5-2 under the EXPANDED formation set", () => {
    // GK 1, DEF 10-12, MID 20-24, FWD 30-31.
    const xi352 = [1, 10, 11, 12, 20, 21, 22, 23, 24, 30, 31];
    expect(code(() => validateLineupSelection(roster(), xi352, 1, null))).toBe(
      "ILLEGAL_FORMATION",
    );
    const f = validateLineupSelection(
      roster(),
      xi352,
      1,
      null,
      FORMATION_SETS.EXPANDED,
    );
    expect(f).toEqual({ GK: 1, DEF: 3, MID: 5, FWD: 2 });
  });

  it("rejects illegal formations (3 DEF)", () => {
    // 1 GK, 3 DEF, 4 MID, 3 FWD = 11 but DEF < 4.
    const xi = [1, 10, 11, 12, 20, 21, 22, 23, 30, 31, 32];
    expect(code(() => validateLineupSelection(roster(), xi, 1, null))).toBe(
      "ILLEGAL_FORMATION",
    );
  });

  it("rejects two goalkeepers", () => {
    // 2 GK, 4 DEF, 3 MID, 2 FWD = 11 but GK != 1.
    const xi = [1, 2, 10, 11, 12, 13, 20, 21, 22, 30, 31];
    expect(code(() => validateLineupSelection(roster(), xi, 1, null))).toBe(
      "ILLEGAL_FORMATION",
    );
  });

  it("requires the captain in the XI", () => {
    expect(code(() => validateLineupSelection(roster(), XI_433, 27, null))).toBe(
      "CAPTAIN_NOT_IN_XI",
    );
  });

  it("requires the vice in the XI and distinct from the captain", () => {
    expect(code(() => validateLineupSelection(roster(), XI_433, 1, 1))).toBe(
      "VICE_IS_CAPTAIN",
    );
    expect(code(() => validateLineupSelection(roster(), XI_433, 1, 27))).toBe(
      "VICE_NOT_IN_XI",
    );
  });
});

function mkRow(
  scoringPeriodId: number,
  playerIds: number[],
  captain: number,
  vice: number | null,
): LineupRow {
  return {
    fantasyTeamId: 1,
    scoringPeriodId,
    playerIds,
    captainPlayerId: captain,
    viceCaptainPlayerId: vice,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
  };
}

describe("effectiveLineupForOrdinal (roll-forward)", () => {
  const ords = new Map([
    [101, 1],
    [103, 3],
  ]);
  const r1 = mkRow(101, XI_433, 1, null);
  const r3 = mkRow(103, XI_433, 10, null);

  it("uses the submitted row for its own period", () => {
    expect(effectiveLineupForOrdinal([r1, r3], ords, 1)).toBe(r1);
    expect(effectiveLineupForOrdinal([r1, r3], ords, 3)).toBe(r3);
  });

  it("rolls the most recent earlier lineup forward", () => {
    expect(effectiveLineupForOrdinal([r1, r3], ords, 2)).toBe(r1);
    expect(effectiveLineupForOrdinal([r1, r3], ords, 9)).toBe(r3);
  });

  it("returns null before any submission", () => {
    expect(effectiveLineupForOrdinal([r3], ords, 1)).toBeNull();
    expect(effectiveLineupForOrdinal([], ords, 5)).toBeNull();
  });

  it("ignores rows whose period is unknown to the competition", () => {
    const stray = mkRow(999, XI_433, 1, null);
    expect(effectiveLineupForOrdinal([stray], ords, 5)).toBeNull();
  });
});

describe("scoreSetLineupPeriod", () => {
  const slots = new Map<number, SetLineupSlotInput>(
    XI_433.map((pid, i) => [
      pid,
      {
        position: (pid === 1 ? "GK" : pid < 20 ? "DEF" : pid < 30 ? "MID" : "FWD") as Position,
        points: i + 1, // 1..11, total 66
        fullName: `P${pid}`,
      },
    ]),
  );

  it("scores 0 with an empty XI when no lineup applies", () => {
    const r = scoreSetLineupPeriod(null, slots, new Set());
    expect(r).toEqual({ formation: "-", points: 0, xi: [] });
  });

  it("doubles the captain when they featured", () => {
    // Captain pid=1 has 1 point -> doubled adds 1: total 67.
    const r = scoreSetLineupPeriod(mkRow(101, XI_433, 1, 30), slots, new Set(XI_433));
    expect(r.points).toBe(67);
    expect(r.xi.find((s) => s.playerId === 1)?.points).toBe(2);
    expect(r.formation).toBe("4-3-3");
  });

  it("promotes the vice when the captain did not feature", () => {
    // Captain 1 absent; vice 30 (9 points) doubled -> total 66 + 9 = 75.
    const featured = new Set(XI_433.filter((p) => p !== 1));
    const r = scoreSetLineupPeriod(mkRow(101, XI_433, 1, 30), slots, featured);
    expect(r.points).toBe(75);
    expect(r.xi.find((s) => s.playerId === 30)?.points).toBe(18);
    expect(r.xi.find((s) => s.playerId === 1)?.points).toBe(1);
  });

  it("doubles nobody when neither captain nor vice featured", () => {
    const featured = new Set(XI_433.filter((p) => p !== 1 && p !== 30));
    const r = scoreSetLineupPeriod(mkRow(101, XI_433, 1, 30), slots, featured);
    expect(r.points).toBe(66);
  });

  it("doubles nobody when the captain is absent and there is no vice", () => {
    const featured = new Set(XI_433.filter((p) => p !== 1));
    const r = scoreSetLineupPeriod(mkRow(101, XI_433, 1, null), slots, featured);
    expect(r.points).toBe(66);
  });
});
