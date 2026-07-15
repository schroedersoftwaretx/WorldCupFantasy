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

import type { FormationSet, Position } from "../db/schema.js";

/** A starting-XI shape. GK is always 1. */
export interface XiFormation {
  GK: 1;
  DEF: number;
  MID: number;
  FWD: number;
}

/** Per-position outfield count range. */
interface OutfieldRanges {
  DEF: { min: number; max: number };
  MID: { min: number; max: number };
  FWD: { min: number; max: number };
}

/** GK is fixed at 1, so an XI always has 10 outfielders. */
const XI_OUTFIELD = 10;

/**
 * Outfield ranges per formation set. CLASSIC is section 4.1 of the original
 * plan; EXPANDED widens each range to the FPL bounds (min 3 DEF, min 1 FWD),
 * adding back-three and lone-striker shapes. Formations are GENERATED from
 * the ranges so each rule lives in one place.
 */
const SET_RANGES: Record<FormationSet, OutfieldRanges> = {
  CLASSIC: {
    DEF: { min: 4, max: 5 },
    MID: { min: 2, max: 4 },
    FWD: { min: 2, max: 3 },
  },
  EXPANDED: {
    DEF: { min: 3, max: 5 },
    MID: { min: 2, max: 5 },
    FWD: { min: 1, max: 3 },
  },
};

/** Generate every legal formation from a set's ranges. */
function generateFormations(ranges: OutfieldRanges): XiFormation[] {
  const out: XiFormation[] = [];
  for (let d = ranges.DEF.min; d <= ranges.DEF.max; d += 1) {
    for (let m = ranges.MID.min; m <= ranges.MID.max; m += 1) {
      for (let f = ranges.FWD.min; f <= ranges.FWD.max; f += 1) {
        if (d + m + f === XI_OUTFIELD) {
          out.push({ GK: 1, DEF: d, MID: m, FWD: f });
        }
      }
    }
  }
  return out;
}

/** Every formation set's legal formations, generated once. */
export const FORMATION_SETS: Record<FormationSet, readonly XiFormation[]> = {
  CLASSIC: Object.freeze(generateFormations(SET_RANGES.CLASSIC)),
  EXPANDED: Object.freeze(generateFormations(SET_RANGES.EXPANDED)),
};

/**
 * The four legal World Cup Fantasy formations - the CLASSIC set. Kept as the
 * default everywhere so leagues that never chose a set score byte-identically.
 */
export const LEGAL_FORMATIONS: readonly XiFormation[] = FORMATION_SETS.CLASSIC;

/** The legal formations for a league's formation set. */
export function formationsForSet(set: FormationSet): readonly XiFormation[] {
  return FORMATION_SETS[set];
}

/**
 * Can this pool of players field at least one formation of the set? (Each
 * formation needs its exact counts, so >= per position over some formation.)
 */
export function canFieldFormation(
  players: readonly ScoredPlayer[],
  formations: readonly XiFormation[] = LEGAL_FORMATIONS,
): boolean {
  const counts: Record<Position, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const p of players) counts[p.position] += 1;
  return formations.some(
    (f) =>
      counts.GK >= f.GK &&
      counts.DEF >= f.DEF &&
      counts.MID >= f.MID &&
      counts.FWD >= f.FWD,
  );
}

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
 * Returns the best result across the given formations (default CLASSIC, so
 * existing callers are byte-identical). If the roster is too thin to fill a
 * given formation (should not happen for a legal 23-man roster) that
 * formation is skipped; if no formation is fillable a null result is
 * impossible for a complete roster, so we throw.
 */
export function optimizeBestBall(
  roster: readonly ScoredPlayer[],
  formations: readonly XiFormation[] = LEGAL_FORMATIONS,
): BestBallResult {
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
  for (const formation of formations) {
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
