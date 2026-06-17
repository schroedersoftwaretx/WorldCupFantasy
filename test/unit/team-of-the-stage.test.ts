/**
 * Unit tests for the Team-of-the-Stage pure core (no database).
 *
 * optimizeGlobalXi guards the best-ball optimizer so a pool that cannot fill
 * any legal formation returns null, and otherwise returns the single
 * highest-scoring legal XI across the four formations. The fixture below is a
 * formation-boundary case: a very high 5th defender makes a 5-back optimal.
 */
import { describe, expect, it } from "vitest";

import { formationLabel } from "../../src/data/standings/lineup.js";
import type { ScoredPlayer } from "../../src/data/standings/lineup.js";
import {
  canFieldAnyFormation,
  optimizeGlobalXi,
} from "../../src/data/stats/team-of-the-stage.js";

let nextId = 1;
function sp(position: ScoredPlayer["position"], points: number): ScoredPlayer {
  return { playerId: nextId++, position, points };
}

describe("optimizeGlobalXi (pure)", () => {
  it("returns null when the pool cannot field any legal formation", () => {
    const pool: ScoredPlayer[] = [sp("GK", 5), sp("DEF", 4), sp("FWD", 3)];
    expect(canFieldAnyFormation(pool)).toBe(false);
    expect(optimizeGlobalXi(pool)).toBeNull();
  });

  it("picks the max-scoring legal XI at a 5-back formation boundary", () => {
    // GK 10; DEF 9x5; MID 8,8,2,1; FWD 8,8,5. All four formations are
    // fillable. 5-2-3 = 10 + (9*5=45) + (8+8) + (8+8+5) = 92 beats 4-3-3 (85),
    // 4-4-2 (81), and 5-3-2 (89): a genuine 5-back optimum.
    const pool: ScoredPlayer[] = [
      sp("GK", 10),
      sp("DEF", 9), sp("DEF", 9), sp("DEF", 9), sp("DEF", 9), sp("DEF", 9),
      sp("MID", 8), sp("MID", 8), sp("MID", 2), sp("MID", 1),
      sp("FWD", 8), sp("FWD", 8), sp("FWD", 5),
    ];
    const best = optimizeGlobalXi(pool);
    expect(best).not.toBeNull();
    expect(best!.points).toBe(92);
    expect(formationLabel(best!.formation)).toBe("5-2-3");
    expect(best!.xi).toHaveLength(11);
    expect(best!.xi.filter((p) => p.position === "DEF")).toHaveLength(5);
    // The weak mids (2, 1) are excluded.
    expect(best!.xi.some((p) => p.points === 1)).toBe(false);

    // Brute-force cross-check: the returned total is the maximum achievable.
    const byPos = { GK: [] as number[], DEF: [] as number[], MID: [] as number[], FWD: [] as number[] };
    for (const p of pool) byPos[p.position].push(p.points);
    for (const k of Object.keys(byPos) as (keyof typeof byPos)[]) {
      byPos[k].sort((a, b) => b - a);
    }
    const sumTop = (arr: number[], n: number) => arr.slice(0, n).reduce((a, b) => a + b, 0);
    let max = -Infinity;
    const formations: [number, number, number][] = [[4, 3, 3], [4, 4, 2], [5, 2, 3], [5, 3, 2]];
    for (const [d, m, f] of formations) {
      max = Math.max(max, sumTop(byPos.GK, 1) + sumTop(byPos.DEF, d) + sumTop(byPos.MID, m) + sumTop(byPos.FWD, f));
    }
    expect(best!.points).toBe(max);
  });
});
