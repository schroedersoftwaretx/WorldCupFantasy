/**
 * Constraint-aware autopick (pure).
 *
 * When a manager's 12-hour pick timer expires, the draft must pick FOR
 * them. Per section 6.3 of the plan the autopick must take "the best
 * available player that (a) violates no draft cap and (b) does not make a
 * legal 23-man roster impossible given the manager's remaining picks".
 *
 * This module is the algorithm; the draft service supplies the inputs
 * (the team's current position counts, and the players still available in
 * the league) and persists the result.
 *
 *   1. LEGALITY FILTER. A candidate is legal only if `canAddPlayer`
 *      accepts it - that single check enforces both the per-position draft
 *      cap (a) and roster completability (b). Completability is the
 *      genuinely non-trivial part: taking, say, a 9th outfielder can be
 *      under every cap yet still strand a position minimum once too few
 *      picks remain. `canAddPlayer` rejects exactly those.
 *
 *   2. VALUE ORDERING. Among legal candidates, the best is the one with
 *      the lowest `draftRank` (a pre-tournament big board). Unranked
 *      players sort after all ranked ones; ties break by playerId so the
 *      result is fully deterministic - the same board always autopicks the
 *      same player.
 *
 * Everything here is pure, so the autopick is unit-testable without a DB.
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
  /** Pre-tournament rank; lower is better. null = unranked. */
  draftRank: number | null;
}

/**
 * Order two candidates best-first: lower draftRank wins, unranked players
 * lose to ranked ones, and playerId breaks all remaining ties.
 */
export function compareCandidates(a: AutopickCandidate, b: AutopickCandidate): number {
  const ar = a.draftRank;
  const br = b.draftRank;
  if (ar !== null && br !== null) {
    if (ar !== br) return ar - br;
  } else if (ar !== null && br === null) {
    return -1;
  } else if (ar === null && br !== null) {
    return 1;
  }
  // Equal rank, or both unranked: deterministic tie-break.
  return a.playerId - b.playerId;
}

/**
 * The single best candidate from a pre-filtered legal list, or null if the
 * list is empty.
 */
export function selectBestCandidate(
  candidates: readonly AutopickCandidate[],
): AutopickCandidate | null {
  let best: AutopickCandidate | null = null;
  for (const c of candidates) {
    if (best === null || compareCandidates(c, best) < 0) best = c;
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
 * Choose the autopick: filter the available pool to legal candidates, then
 * take the best by draft rank. A null `pick` means no legal pick exists
 * (e.g. the roster is already full, or - pathologically - the pool has no
 * player of any still-needed position).
 */
export function chooseAutopick(
  counts: PositionCounts,
  available: readonly AutopickCandidate[],
  reqs: RosterRequirements = ROSTER_REQUIREMENTS,
): AutopickResult {
  const legal = legalAutopickCandidates(counts, available, reqs);
  return { pick: selectBestCandidate(legal), legalCount: legal.length };
}
