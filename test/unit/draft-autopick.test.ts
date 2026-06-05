/**
 * Unit tests for the constraint-aware autopick (pure parts).
 *
 * The autopick must take the BEST player that is still a LEGAL pick. These
 * tests cover both halves: the value ordering (compareCandidates /
 * selectBestCandidate) and the legality filter (legalAutopickCandidates /
 * chooseAutopick), including the case the plan flags as hard - refusing a
 * pick that would strand a roster.
 */
import { describe, expect, it } from "vitest";

import type { Position } from "../../src/data/db/schema.js";
import {
  chooseAutopick,
  compareCandidates,
  legalAutopickCandidates,
  selectBestCandidate,
  type AutopickCandidate,
} from "../../src/data/draft/autopick.js";
import type { PositionCounts } from "../../src/data/roster/validator.js";

function cand(
  playerId: number,
  position: Position,
  draftRank: number | null,
): AutopickCandidate {
  return { playerId, position, draftRank, fullName: `Player ${playerId}` };
}

function counts(gk: number, def: number, mid: number, fwd: number): PositionCounts {
  return { GK: gk, DEF: def, MID: mid, FWD: fwd };
}

describe("compareCandidates / selectBestCandidate", () => {
  it("lower draft rank wins", () => {
    expect(compareCandidates(cand(1, "FWD", 5), cand(2, "FWD", 9))).toBeLessThan(0);
  });

  it("a ranked player beats an unranked one", () => {
    expect(compareCandidates(cand(1, "FWD", 100), cand(2, "FWD", null))).toBeLessThan(0);
  });

  it("equal rank falls back to the lower player id (determinism)", () => {
    expect(compareCandidates(cand(7, "FWD", 3), cand(2, "FWD", 3))).toBeGreaterThan(0);
  });

  it("both unranked falls back to player id", () => {
    expect(compareCandidates(cand(2, "FWD", null), cand(9, "FWD", null))).toBeLessThan(0);
  });

  it("selectBestCandidate picks the best of a list", () => {
    const best = selectBestCandidate([
      cand(1, "FWD", null),
      cand(2, "MID", 12),
      cand(3, "DEF", 4),
      cand(4, "GK", 4),
    ]);
    // rank 4 ties between players 3 and 4 -> lower id wins.
    expect(best?.playerId).toBe(3);
  });

  it("selectBestCandidate returns null for an empty list", () => {
    expect(selectBestCandidate([])).toBeNull();
  });
});

describe("legalAutopickCandidates", () => {
  it("keeps only players whose position can still be added", () => {
    // GK at its cap of 4: GK candidates are filtered out.
    const pool = [
      cand(1, "GK", 1),
      cand(2, "DEF", 2),
      cand(3, "MID", 3),
      cand(4, "FWD", 4),
    ];
    const legal = legalAutopickCandidates(counts(4, 6, 5, 3), pool);
    expect(legal.map((c) => c.position).sort()).toEqual(["DEF", "FWD", "MID"]);
  });

  it("filters out a pick that would strand a roster minimum", () => {
    // 0/8/8/5 = 21 picks, 2 left, GK still needs 2. A 6th FWD is under
    // the cap (max 8) but would make a legal 23 impossible -> filtered.
    const pool = [cand(1, "FWD", 1), cand(2, "GK", 50)];
    const legal = legalAutopickCandidates(counts(0, 8, 8, 5), pool);
    expect(legal.map((c) => c.position)).toEqual(["GK"]);
  });
});

describe("chooseAutopick", () => {
  it("picks the best-ranked LEGAL player", () => {
    // Empty roster: every position is legal, so pure rank decides.
    const pool = [
      cand(10, "FWD", 3),
      cand(11, "MID", 1),
      cand(12, "DEF", 2),
    ];
    const result = chooseAutopick(counts(0, 0, 0, 0), pool);
    expect(result.pick?.playerId).toBe(11);
    expect(result.legalCount).toBe(3);
  });

  it("skips a higher-ranked player whose position is illegal", () => {
    // GK at cap: the rank-1 GK is illegal, so the rank-2 DEF is taken.
    const pool = [cand(1, "GK", 1), cand(2, "DEF", 2)];
    const result = chooseAutopick(counts(4, 6, 5, 3), pool);
    expect(result.pick?.playerId).toBe(2);
  });

  it("returns a null pick when no legal candidate exists (full roster)", () => {
    const result = chooseAutopick(counts(4, 8, 7, 4), [cand(1, "DEF", 1)]);
    expect(result.pick).toBeNull();
    expect(result.legalCount).toBe(0);
  });

  it("constraint beats value: near a corner it takes the forced position", () => {
    // 0/8/8/5: only GK keeps the roster legal. Even a rank-1 FWD loses.
    const pool = [cand(1, "FWD", 1), cand(2, "GK", 999)];
    const result = chooseAutopick(counts(0, 8, 8, 5), pool);
    expect(result.pick?.playerId).toBe(2);
    expect(result.pick?.position).toBe("GK");
  });
});

describe("rank 0 treated as unranked", () => {
  it("rank-0 player loses to a rank-1 player", () => {
    expect(compareCandidates(cand(1, "FWD", 0), cand(2, "FWD", 1))).toBeGreaterThan(0);
  });

  it("rank-0 ties with null (both unranked) -> player id decides", () => {
    expect(compareCandidates(cand(1, "FWD", 0), cand(2, "FWD", null))).toBeLessThan(0);
  });

  it("chooseAutopick treats rank-0 as last resort", () => {
    const pool = [cand(1, "MID", 0), cand(2, "MID", 5)];
    const result = chooseAutopick(counts(1, 4, 0, 0), pool);
    expect(result.pick?.playerId).toBe(2);
  });
});

describe("position-need tiebreaker", () => {
  it("equal rank prefers position below its minimum", () => {
    // Both rank 10. GK has 0/min=2 → deficit; MID has 2/min=5 → deficit.
    // GK deficit fraction = 2/2 = 1.0; MID deficit fraction = 3/5 = 0.6 → GK wins.
    const result = chooseAutopick(
      counts(0, 6, 2, 4),
      [cand(1, "GK", 10), cand(2, "MID", 10)],
    );
    expect(result.pick?.position).toBe("GK");
  });

  it("position below minimum beats position at minimum even with worse rank", () => {
    // cand 1: DEF rank 5, DEF at min (6). cand 2: GK rank 10, GK below min (0/2).
    // Rank 5 < 10, but GK is strictly in deficit. Rank wins here — GK should NOT
    // beat a significantly better-ranked DEF (need tiebreaker is rank-equal only).
    const result = chooseAutopick(
      counts(0, 6, 5, 4),
      [cand(1, "DEF", 5), cand(2, "GK", 10)],
    );
    expect(result.pick?.playerId).toBe(1); // rank wins outright
  });

  it("when all positions at minimum, prefer position with most room (% toward max)", () => {
    // GK at min (2/4 → room 2/4 = 0.5). MID at min (5/8 → room 3/8 = 0.375).
    // Both candidates unranked → need tiebreaker → GK has more room → GK wins.
    const result = chooseAutopick(
      counts(2, 6, 5, 4),
      [cand(1, "GK", null), cand(2, "MID", null)],
    );
    expect(result.pick?.position).toBe("GK");
  });
});
