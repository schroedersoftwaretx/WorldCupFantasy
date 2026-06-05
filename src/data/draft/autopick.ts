/**
 * Constraint-aware autopick (pure).
 *
 * When a manager's pick timer expires, the draft must pick FOR them.
 * Per section 6.3 of the plan the autopick must take "the best available
 * player that (a) violates no draft cap and (b) does not make a legal
 * 23-man roster impossible given the manager's remaining picks".
 *
 * Ordering (most important → least):
 *   1. RANK   — lower draftRank wins; rank 0 and null are treated as
 *               unranked and sort after all ranked players.
 *   2. NEED   — when ranks are equal (or both unranked), prefer the
 *               position that is more urgent:
 *                 • Below minimum: score = deficit / posMin  (1–2 range)
 *                 • At/above minimum: score = room / posMax  (0–1 range)
 *               A position below its minimum always beats one at minimum.
 *               Within each tier, higher percentage = more preferred.
 *   3. PLAYER ID — last deterministic tiebreak.
 *
 * Everything here is pure so the autopick is unit-testable without a DB.
 */

import type { Position } from "../db/schema.js";
import {
  ROSTER_REQUIREMENTS,
  canAddPlayer,
  type PositionCounts,
  type RosterRequirements,
} from "../roster/validator.js";

/** A player the autopick may consider. */
export interface AutopickCandidate {
  playerId: number;
  fullName: string;
  position: Position;
  /** Pre-tournament rank; lower is better. null or 0 = unranked. */
  draftRank: number | null;
}

/** Normalise rank: treat 0 and null as "unranked" (sorts last). */
function effectiveRank(c: AutopickCandidate): number | null {
  if (c.draftRank == null || c.draftRank <= 0) return null;
  return c.draftRank;
}

/**
 * Score how urgently a position needs to be filled.
 *   Below minimum → score in (1, 2]: 1 + deficit/posMin
 *   At/above min  → score in [0, 1): room/posMax
 * Higher score = higher priority.
 */
function positionNeedScore(
  pos: Position,
  counts: PositionCounts,
  reqs: RosterRequirements,
): number {
  const range = reqs.byPosition[pos];
  const current = counts[pos];
  const deficit = Math.max(0, range.min - current);
  const room = Math.max(0, range.max - current);
  if (deficit > 0) {
    return 1 + deficit / range.min;
  }
  return room / range.max;
}

/**
 * Order two candidates best-first.
 * Optionally accepts the current roster counts to enable the position-need
 * tiebreaker; without counts only rank and playerId are used.
 */
export function compareCandidates(
  a: AutopickCandidate,
  b: AutopickCandidate,
  counts?: PositionCounts,
  reqs: RosterRequirements = ROSTER_REQUIREMENTS,
): number {
  const ar = effectiveRank(a);
  const br = effectiveRank(b);

  // Both ranked: compare directly.
  if (ar !== null && br !== null) {
    if (ar !== br) return ar - br;
  } else if (ar !== null && br === null) {
    return -1; // a ranked, b not → a wins
  } else if (ar === null && br !== null) {
    return 1; // b ranked, a not → b wins
  }
  // Ranks equal (or both unranked) — apply position-need tiebreaker.
  if (counts) {
    const na = positionNeedScore(a.position, counts, reqs);
    const nb = positionNeedScore(b.position, counts, reqs);
    if (Math.abs(na - nb) > 1e-9) return nb - na; // higher need first
  }
  // Final deterministic tiebreak.
  return a.playerId - b.playerId;
}

/**
 * The single best candidate from a pre-filtered legal list, or null if the
 * list is empty. Passing `counts` enables the position-need tiebreaker.
 */
export function selectBestCandidate(
  candidates: readonly AutopickCandidate[],
  counts?: PositionCounts,
  reqs: RosterRequirements = ROSTER_REQUIREMENTS,
): AutopickCandidate | null {
  let best: AutopickCandidate | null = null;
  for (const c of candidates) {
    if (best === null || compareCandidates(c, best, counts, reqs) < 0) best = c;
  }
  return best;
}

/**
 * Filter a pool of available players to those that may legally be added to
 * a roster with the given position counts.
 */
export function legalAutopickCandidates(
  counts: PositionCounts,
  available: readonly AutopickCandidate[],
  reqs: RosterRequirements = ROSTER_REQUIREMENTS,
): AutopickCandidate[] {
  return available.filter((c) => canAddPlayer(counts, c.position, reqs).ok);
}

export interface AutopickResult {
  /** The chosen player, or null if no legal pick exists. */
  pick: AutopickCandidate | null;
  /** How many of the available pool were legal picks. */
  legalCount: number;
}

/**
 * Choose the autopick: filter to legal candidates, then take the best by
 * rank (with position-need tiebreaker). A null `pick` means no legal pick
 * exists (roster full, or pool has no player of any still-needed position).
 */
export function chooseAutopick(
  counts: PositionCounts,
  available: readonly AutopickCandidate[],
  reqs: RosterRequirements = ROSTER_REQUIREMENTS,
): AutopickResult {
  const legal = legalAutopickCandidates(counts, available, reqs);
  return { pick: selectBestCandidate(legal, counts, reqs), legalCount: legal.length };
}
