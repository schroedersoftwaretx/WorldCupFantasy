/**
 * SET_LINEUP period scoring (Phase 9 Priority 1) - pure.
 *
 * For a SET_LINEUP league the period XI is the manager's SUBMITTED lineup
 * (rolled forward from the most recent earlier period when none was
 * submitted for the target period), not the best-ball optimum:
 *
 *   - Captain scores DOUBLE, provided they FEATURED in the period (played
 *     any minutes in a fixture of that period).
 *   - If the captain did not feature, the vice-captain is promoted and
 *     doubled instead (again only if the vice featured).
 *   - No lineup submitted yet -> the period scores 0 with an empty XI,
 *     mirroring best-ball's "cannot field an XI" shape.
 *
 * The doubling is shown in the XI slot itself (the captain's slot carries
 * the doubled points), so the period total is always the sum of its slots.
 * All totals are rounded to 2dp, consistent with the scoring engine.
 */
import type { LineupRow, Position } from "../db/schema.js";

export interface SetLineupSlotInput {
  position: Position;
  points: number;
  fullName: string;
}

export interface SetLineupPeriodResult {
  /** "-" when no lineup applies. */
  formation: string;
  points: number;
  xi: Array<{
    playerId: number;
    fullName: string;
    position: Position;
    points: number;
  }>;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Conventional DEF-MID-FWD label from the XI's own position counts. */
function labelFromCounts(counts: Record<Position, number>): string {
  return `${counts.DEF}-${counts.MID}-${counts.FWD}`;
}

/**
 * Score one team's period from its effective submitted lineup. `featured`
 * holds the player ids that played minutes in this period; `slotByPlayerId`
 * supplies each XI player's period points, position and display name.
 */
export function scoreSetLineupPeriod(
  effective: LineupRow | null,
  slotByPlayerId: ReadonlyMap<number, SetLineupSlotInput>,
  featured: ReadonlySet<number>,
): SetLineupPeriodResult {
  if (effective === null) {
    return { formation: "-", points: 0, xi: [] };
  }
  const playerIds = effective.playerIds as number[];

  // Who gets the armband this period: captain if they featured, else the
  // vice if they featured, else nobody doubles.
  let doubled: number | null = null;
  if (featured.has(effective.captainPlayerId)) {
    doubled = effective.captainPlayerId;
  } else if (
    effective.viceCaptainPlayerId !== null &&
    featured.has(effective.viceCaptainPlayerId)
  ) {
    doubled = effective.viceCaptainPlayerId;
  }

  const counts: Record<Position, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  let total = 0;
  const xi = playerIds.map((pid) => {
    const slot = slotByPlayerId.get(pid);
    const position = slot?.position ?? ("MID" as Position);
    const base = slot?.points ?? 0;
    const points = round2(pid === doubled ? base * 2 : base);
    counts[position] += 1;
    total += points;
    return {
      playerId: pid,
      fullName: slot?.fullName ?? `#${pid}`,
      position,
      points,
    };
  });

  return { formation: labelFromCounts(counts), points: round2(total), xi };
}
