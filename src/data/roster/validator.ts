/**
 * Roster validator (Phase 3).
 *
 * A fantasy roster is 23 players with per-position minimums and maximums
 * (section 4.2 / 4.3 of the project plan). The maximums double as the
 * per-manager draft caps, so this single rule set governs both "is this
 * finished roster legal?" and "may this manager draft one more of position
 * X right now?".
 *
 * The genuinely load-bearing function is `isRosterCompletable`: given a
 * partial roster, can the remaining picks still reach a legal 23-man squad
 * without exceeding any maximum? Phase 4's constraint-aware autopick is
 * built directly on top of it - an autopick is only allowed to take a
 * player if the resulting roster is still completable.
 *
 * Everything here is pure: no I/O, no DB. Callers pass in position counts.
 */

import type { Position } from "../db/schema.js";

export interface PositionRange {
  readonly min: number;
  readonly max: number;
}

export interface RosterRequirements {
  /** Total roster size; minimums must sum to <= this, maximums to >=. */
  readonly rosterSize: number;
  readonly byPosition: Readonly<Record<Position, PositionRange>>;
}

/**
 * Canonical requirements from section 4.2 / 4.3 of the plan.
 *
 * Legality proof sketch (from the plan): minimums sum to 17, leaving 6
 * discretionary picks; maximums sum to 28. Since 17 <= 23 <= 28, an empty
 * roster is completable, and every position range is reachable.
 */
export const ROSTER_REQUIREMENTS: RosterRequirements = Object.freeze({
  rosterSize: 23,
  byPosition: Object.freeze({
    GK: { min: 2, max: 4 },
    DEF: { min: 6, max: 8 },
    MID: { min: 5, max: 8 },
    FWD: { min: 4, max: 8 },
  }),
});

const POSITIONS: readonly Position[] = ["GK", "DEF", "MID", "FWD"];

/** A count of rostered players per position. */
export type PositionCounts = Record<Position, number>;

export function emptyCounts(): PositionCounts {
  return { GK: 0, DEF: 0, MID: 0, FWD: 0 };
}

/** Tally a list of positions (e.g. from roster_slot rows) into counts. */
export function countsFromPositions(positions: readonly Position[]): PositionCounts {
  const counts = emptyCounts();
  for (const p of positions) counts[p] += 1;
  return counts;
}

export function totalCount(counts: PositionCounts): number {
  return counts.GK + counts.DEF + counts.MID + counts.FWD;
}

export interface ValidationResult {
  ok: boolean;
  /** Human-readable reasons; empty when ok. */
  errors: string[];
}

/**
 * Validate a COMPLETE 23-man roster: total size exact, every position
 * within [min, max].
 */
export function validateCompleteRoster(
  counts: PositionCounts,
  reqs: RosterRequirements = ROSTER_REQUIREMENTS,
): ValidationResult {
  const errors: string[] = [];
  const total = totalCount(counts);
  if (total !== reqs.rosterSize) {
    errors.push(`roster has ${total} players, must be exactly ${reqs.rosterSize}`);
  }
  for (const pos of POSITIONS) {
    const range = reqs.byPosition[pos];
    const n = counts[pos];
    if (n < range.min) {
      errors.push(`${pos}: ${n} is below minimum ${range.min}`);
    } else if (n > range.max) {
      errors.push(`${pos}: ${n} exceeds maximum ${range.max}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Can a PARTIAL roster still be completed into a legal 23-man squad?
 *
 * Let `remaining = rosterSize - total`. We must distribute `remaining`
 * picks so every position lands in [min, max]. That is feasible iff:
 *
 *   - no position already exceeds its maximum,
 *   - the picks still needed to reach every minimum (the "min deficit")
 *     is <= remaining, and
 *   - the room left below every maximum (the "room to max") is >= remaining.
 *
 * (remaining < 0 - an over-full roster - is also infeasible.)
 */
export function isRosterCompletable(
  counts: PositionCounts,
  reqs: RosterRequirements = ROSTER_REQUIREMENTS,
): boolean {
  const remaining = reqs.rosterSize - totalCount(counts);
  if (remaining < 0) return false;

  let minDeficit = 0;
  let roomToMax = 0;
  for (const pos of POSITIONS) {
    const range = reqs.byPosition[pos];
    const n = counts[pos];
    if (n > range.max) return false;
    minDeficit += Math.max(0, range.min - n);
    roomToMax += range.max - n;
  }
  return minDeficit <= remaining && remaining <= roomToMax;
}

export interface AddPlayerCheck {
  ok: boolean;
  /** Set when ok is false. */
  reason?: string;
}

/**
 * May one more player of `position` be added to a roster with `counts`?
 *
 * Rejects when adding would (a) exceed the position maximum / draft cap,
 * (b) overflow the roster size, or (c) make a legal 23-man roster
 * impossible (e.g. taking a 6th MID when the GK minimum can no longer be
 * reached with the picks left). This (c) case is exactly what stops a
 * manager - or an autopick - from drafting into an illegal corner.
 */
export function canAddPlayer(
  counts: PositionCounts,
  position: Position,
  reqs: RosterRequirements = ROSTER_REQUIREMENTS,
): AddPlayerCheck {
  const range = reqs.byPosition[position];
  if (counts[position] + 1 > range.max) {
    return {
      ok: false,
      reason: `${position} is at its maximum of ${range.max} (draft cap)`,
    };
  }
  if (totalCount(counts) + 1 > reqs.rosterSize) {
    return { ok: false, reason: `roster is already full (${reqs.rosterSize})` };
  }
  const next: PositionCounts = { ...counts, [position]: counts[position] + 1 };
  if (!isRosterCompletable(next, reqs)) {
    return {
      ok: false,
      reason:
        `adding a ${position} would make a legal ${reqs.rosterSize}-man roster ` +
        `impossible with the remaining picks`,
    };
  }
  return { ok: true };
}

export interface RemainingNeeds {
  /** Picks still required to reach each position minimum. */
  deficit: PositionCounts;
  /** Picks that may still be added to each position before its maximum. */
  room: PositionCounts;
  /** Total picks left before the roster is full. */
  remaining: number;
}

/**
 * Decompose how much room a partial roster has. Phase 4's autopick uses
 * this to know which positions it is still free to take and which it is
 * obliged to take.
 */
export function remainingNeeds(
  counts: PositionCounts,
  reqs: RosterRequirements = ROSTER_REQUIREMENTS,
): RemainingNeeds {
  const deficit = emptyCounts();
  const room = emptyCounts();
  for (const pos of POSITIONS) {
    const range = reqs.byPosition[pos];
    deficit[pos] = Math.max(0, range.min - counts[pos]);
    room[pos] = Math.max(0, range.max - counts[pos]);
  }
  return {
    deficit,
    room,
    remaining: reqs.rosterSize - totalCount(counts),
  };
}
