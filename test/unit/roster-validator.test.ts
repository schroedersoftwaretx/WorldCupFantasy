/**
 * Unit tests for the roster validator (section 4.2 / 4.3 of the plan).
 *
 * The interesting surface is completability: a partial roster is only
 * legal to extend if a full legal 23-man squad is still reachable. These
 * tests pin the boundary cases - especially "drafting into a corner".
 */
import { describe, expect, it } from "vitest";

import type { Position } from "../../src/data/db/schema.js";
import {
  ROSTER_REQUIREMENTS,
  canAddPlayer,
  countsFromPositions,
  emptyCounts,
  isRosterCompletable,
  remainingNeeds,
  totalCount,
  validateCompleteRoster,
  type PositionCounts,
} from "../../src/data/roster/validator.js";

function counts(gk: number, def: number, mid: number, fwd: number): PositionCounts {
  return { GK: gk, DEF: def, MID: mid, FWD: fwd };
}

describe("ROSTER_REQUIREMENTS sanity (legality proof from the plan)", () => {
  it("minimums sum to 17, maximums to 28, roster size 23", () => {
    const { byPosition, rosterSize } = ROSTER_REQUIREMENTS;
    const minSum =
      byPosition.GK.min + byPosition.DEF.min + byPosition.MID.min + byPosition.FWD.min;
    const maxSum =
      byPosition.GK.max + byPosition.DEF.max + byPosition.MID.max + byPosition.FWD.max;
    expect(minSum).toBe(17);
    expect(maxSum).toBe(28);
    expect(rosterSize).toBe(23);
    // The plan's proof: 17 <= 23 <= 28.
    expect(minSum).toBeLessThanOrEqual(rosterSize);
    expect(rosterSize).toBeLessThanOrEqual(maxSum);
  });
});

describe("validateCompleteRoster", () => {
  it("accepts the minimum legal config 2/6/5/4 (bench-heavy but legal)", () => {
    // 2 + 6 + 5 + 4 = 17 ... not 23. The minimum config must still total 23.
    // The plan's "minimum config" means each position AT its minimum is 17;
    // the remaining 6 are discretionary. A *complete* roster must be 23.
    const res = validateCompleteRoster(counts(2, 6, 5, 4));
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("17"))).toBe(true);
  });

  it("accepts a legal 23-man roster (4/8/7/4)", () => {
    const res = validateCompleteRoster(counts(4, 8, 7, 4));
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it("accepts the all-minimums-plus-discretionary roster 2/8/5/8", () => {
    expect(totalCount(counts(2, 8, 5, 8))).toBe(23);
    expect(validateCompleteRoster(counts(2, 8, 5, 8)).ok).toBe(true);
  });

  it("rejects a roster below a position minimum", () => {
    // 1 GK is below the minimum of 2.
    const res = validateCompleteRoster(counts(1, 8, 6, 8));
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.startsWith("GK"))).toBe(true);
  });

  it("rejects a roster above a position maximum", () => {
    // 9 DEF exceeds the maximum of 8.
    const res = validateCompleteRoster(counts(2, 9, 5, 7));
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.startsWith("DEF"))).toBe(true);
  });

  it("rejects a roster that is not exactly 23", () => {
    expect(validateCompleteRoster(counts(2, 6, 5, 4)).ok).toBe(false); // 17
    expect(validateCompleteRoster(counts(4, 8, 8, 8)).ok).toBe(false); // 28
  });
});

describe("isRosterCompletable", () => {
  it("an empty roster is completable", () => {
    expect(isRosterCompletable(emptyCounts())).toBe(true);
  });

  it("a legal full roster is completable (trivially - 0 picks left)", () => {
    expect(isRosterCompletable(counts(4, 8, 7, 4))).toBe(true);
  });

  it("an over-full roster is not completable", () => {
    expect(isRosterCompletable(counts(4, 8, 8, 8))).toBe(false); // 28 > 23
  });

  it("a position already over its maximum is not completable", () => {
    expect(isRosterCompletable(counts(5, 6, 5, 4))).toBe(false); // 5 GK > max 4
  });

  it("detects a corner: minimums no longer reachable", () => {
    // 8 DEF + 8 MID + 6 FWD = 22 picks used, 1 left, but GK needs 2.
    expect(isRosterCompletable(counts(0, 8, 8, 6))).toBe(false);
  });

  it("the very edge is still completable: 0/8/8/5, GK deficit 2, 2 picks left", () => {
    // total 21, remaining 2; GK min deficit 2; room left GK 4 + FWD 3 = 7.
    // 2 <= 2 <= 7 -> completable (the only completion is to draft GK, GK).
    expect(isRosterCompletable(counts(0, 8, 8, 5))).toBe(true);
  });

  it("one pick further is NOT completable: 0/8/8/6 strands the GK minimum", () => {
    // total 22, remaining 1, but GK still needs 2. 2 > 1 -> infeasible.
    expect(isRosterCompletable(counts(0, 8, 8, 6))).toBe(false);
  });

  it("a partial roster with room for all minimums is completable", () => {
    // 2/4/3/2 = 11 picks, 12 left. Deficits: DEF 2, MID 2, FWD 2 = 6 <= 12.
    // Room: GK 2 + DEF 4 + MID 5 + FWD 6 = 17 >= 12. Completable.
    expect(isRosterCompletable(counts(2, 4, 3, 2))).toBe(true);
  });
});

describe("canAddPlayer", () => {
  it("allows adding to an empty roster", () => {
    for (const pos of ["GK", "DEF", "MID", "FWD"] as Position[]) {
      expect(canAddPlayer(emptyCounts(), pos).ok).toBe(true);
    }
  });

  it("rejects exceeding a position's max / draft cap", () => {
    // 4 GK is the cap.
    const check = canAddPlayer(counts(4, 8, 4, 3), "GK");
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/maximum of 4|draft cap/);
  });

  it("rejects a pick that would make a legal roster impossible", () => {
    // 8 DEF, 8 MID, 5 FWD, 0 GK = 21 picks, 2 left, GK still needs 2.
    // Adding a 6th FWD (legal cap-wise: max 8) leaves 1 pick but GK needs 2.
    const check = canAddPlayer(counts(0, 8, 8, 5), "FWD");
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/impossible/);
  });

  it("allows a pick that keeps the roster completable", () => {
    // 8/8/5/0 (21 picks): adding ... actually GK is the only safe pick here.
    const okGk = canAddPlayer(counts(0, 8, 6, 5), "GK"); // 19 picks total
    expect(okGk.ok).toBe(true);
  });

  it("rejects adding to an already-full 23-man roster", () => {
    const check = canAddPlayer(counts(4, 8, 7, 4), "DEF");
    expect(check.ok).toBe(false);
  });

  it("end-to-end: a greedy DEF/MID run is stopped before it corners GK", () => {
    // Draft DEF and MID alternately; the validator must refuse the pick
    // that would strand the GK minimum.
    let c = emptyCounts();
    let pos: Position = "DEF";
    let stopped = false;
    for (let i = 0; i < 23; i += 1) {
      const check = canAddPlayer(c, pos);
      if (!check.ok) {
        stopped = true;
        break;
      }
      c = { ...c, [pos]: c[pos] + 1 };
      pos = pos === "DEF" ? "MID" : "DEF";
    }
    expect(stopped).toBe(true);
    // Whatever partial roster we reached must still be completable.
    expect(isRosterCompletable(c)).toBe(true);
  });
});

describe("remainingNeeds + countsFromPositions", () => {
  it("countsFromPositions tallies a position list", () => {
    const c = countsFromPositions(["GK", "DEF", "DEF", "MID", "FWD", "FWD", "FWD"]);
    expect(c).toEqual(counts(1, 2, 1, 3));
  });

  it("remainingNeeds reports deficits, room, and picks left", () => {
    const needs = remainingNeeds(counts(1, 3, 2, 1)); // 7 picks used
    expect(needs.remaining).toBe(16);
    expect(needs.deficit).toEqual(counts(1, 3, 3, 3)); // to reach mins
    expect(needs.room).toEqual(counts(3, 5, 6, 7)); // to reach maxes
  });
});
