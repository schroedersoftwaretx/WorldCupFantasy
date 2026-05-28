/**
 * Best-ball lineup optimizer (Phase 5) - pure.
 *
 * In best-ball mode there is no lineup deadline: for each scoring period
 * the system retroactively picks the highest-scoring LEGAL starting XI
 * from the manager's 23-man roster. This file is that optimizer.
 *
 * LEGAL FORMATIONS. A starting XI is 1 GK plus 10 outfielders, with
 * (section 4.1 of the plan): DEF 4-5, MID 2-4, FWD 2-3. The flex slots in
 * the plan's wording are just what makes those ranges overlap; enumerating
 * every (DEF,MID,FWD) triple that sums to 10 and lands in range yields
 * exactly four formations: 4-3-3, 4-4-2, 5-2-3, 5-3-2. We generate them
 * from the ranges rather than hard-coding, so the rule lives in one place.
 *
 * WHY THE OPTIMIZER IS EASY ONCE FORMATIONS ARE ENUMERATED. For a FIXED
 * formation the positions are independent: the best DEF block is simply
 * the top-d defenders by points, and so on. So the optimum is
 *   max over the 4 formations of [ topGK + top-d DEF + top-m MID + top-f FWD ].
 * The plan flags best-ball as a hard algorithm because the flex slots look
 * like they couple positions; enumerating formations decouples them.
 *
 * The roster guarantees from Phase 3 (>=2 GK, >=6 DEF, >=5 MID, >=4 FWD)
 * mean every formation is always fillable - the optimizer never fails to
 * field a legal XI.
 */

import type { Position } from "../db/schema.js";

/** A starting-XI shape. GK is always 1. */
export interface XiFormation {
  GK: 1;
  DEF: number;
  MID: number;
  FWD: number;
}

/** Outfield ranges from section 4.1; GK is fixed at 1, XI totals 11. */
const XI_OUTFIELD = 10;
const XI_RANGES = {
  DEF: { min: 4, max: 5 },
  MID: { min: 2, max: 4 },
  FWD: { min: 2, max: 3 },
} as const;

/** Generate every legal formation from the ranges. */
function generateFormations(): XiFormation[] {
  const out: XiFormation[] = [];
  for (let d = XI_RANGES.DEF.min; d <= XI_RANGES.DEF.max; d += 1) {
    for (let m = XI_RANGES.MID.min; m <= XI_RANGES.MID.max; m += 1) {
      for (let f = XI_RANGES.FWD.min; f <= XI_RANGES.FWD.max; f += 1) {
        if (d + m + f === XI_OUTFIELD) {
          out.push({ GK: 1, DEF: d, MID: m, FWD: f });
        }
      }
    }
  }
  return out;
}

/** The four legal World Cup Fantasy formations. */
export const LEGAL_FORMATIONS: readonly XiFormation[] = Object.freeze(
  generateFormations(),
);

/** Conventional DEF-MID-FWD label, e.g. "4-3-3". */
export function formationLabel(f: XiFormation): string {
  return `${f.DEF}-${f.MID}-${f.FWD}`;
}

/** One roster player with the points they scored in some scoring period. */
export interface ScoredPlayer {
  playerId: number;
  position: Position;
  points: number;
}

export interface BestBallResult {
  formation: XiFormation;
  /** The 11 selected players. */
  xi: ScoredPlayer[];
  /** Sum of the XI's points. */
  points: number;
}

/**
 * Best-first ordering within a position: more points first, then lower
 * playerId so the selection is fully deterministic.
 */
function byPointsDesc(a: ScoredPlayer, b: ScoredPlayer): number {
  if (a.points !== b.points) return b.points - a.points;
  return a.playerId - b.playerId;
}

/**
 * Pick the highest-scoring legal starting XI from a roster.
 *
 * Returns the best result across all four formations. If the roster is too
 * thin to fill a given formation (should not happen for a legal 23-man
 * roster) that formation is skipped; if no formation is fillable a null
 * result is impossible for a complete roster, so we throw.
 */
export function optimizeBestBall(roster: readonly ScoredPlayer[]): BestBallResult {
  const byPos: Record<Position, ScoredPlayer[]> = {
    GK: [],
    DEF: [],
    MID: [],
    FWD: [],
  };
  for (const p of roster) byPos[p.position].push(p);
  for (const pos of ["GK", "DEF", "MID", "FWD"] as Position[]) {
    byPos[pos].sort(byPointsDesc);
  }

  let best: BestBallResult | null = null;
  for (const formation of LEGAL_FORMATIONS) {
    const need: Record<Position, number> = {
      GK: formation.GK,
      DEF: formation.DEF,
      MID: formation.MID,
      FWD: formation.FWD,
    };
    let feasible = true;
    const xi: ScoredPlayer[] = [];
    for (const pos of ["GK", "DEF", "MID", "FWD"] as Position[]) {
      const pool = byPos[pos];
      if (pool.length < need[pos]) {
        feasible = false;
        break;
      }
      xi.push(...pool.slice(0, need[pos]));
    }
    if (!feasible) continue;
    const points = xi.reduce((sum, p) => sum + p.points, 0);
    // Strictly-greater keeps the first formation (canonical order) on ties.
    if (best === null || points > best.points) {
      best = { formation, xi, points };
    }
  }

  if (best === null) {
    throw new Error(
      "optimizeBestBall: roster cannot field any legal XI (incomplete roster)",
    );
  }
  return best;
}
