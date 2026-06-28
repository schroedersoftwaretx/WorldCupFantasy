/**
 * Shared types and helpers for the tournament stats aggregation layer.
 *
 * Extracted from aggregate.ts as part of the god-module split (tech-debt #3).
 * The public layer contract is documented on the aggregate.ts barrel. The
 * helpers round2 and fixtureIdsForStage (and the METRIC_COLUMN map) are internal
 * to the split modules and are intentionally NOT re-exported from the barrel,
 * preserving the original public surface.
 */
import { eq, inArray } from "drizzle-orm";

import type { Db, DbTx } from "../db/client.js";
import {
  fixture,
  nationalTeam,
  player,
  stageEnum,
  statLine,
  type Position,
  type Stage,
} from "../db/schema.js";

/** Identity of a player, denormalized with their national team, for display. */
export interface PlayerRef {
  playerId: number;
  fullName: string;
  position: Position;
  nationalTeamId: number;
  nationalTeamName: string;
}

/** A player's fantasy points (from score_entry) over some slice of fixtures. */
export interface PlayerPoints extends PlayerRef {
  /** Total fantasy points, rounded to 2dp. */
  points: number;
  /** Number of fixtures the player has a score_entry for in the slice. */
  appearances: number;
}

/** A player's total of one raw counting stat (from stat_line). */
export interface PlayerStatTotal extends PlayerRef {
  metric: StatMetric;
  total: number;
}

/** Raw counting stats we expose leaders for. */
export type StatMetric = "goals" | "assists" | "saves" | "minutesPlayed";

export const METRIC_COLUMN = {
  goals: statLine.goals,
  assists: statLine.assists,
  saves: statLine.saves,
  minutesPlayed: statLine.minutesPlayed,
} as const;

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Load player refs (with national-team name) for a set of player ids.
 * Exported so the ownership/ADP services (Phase 2) reuse the exact same
 * PlayerRef shape rather than re-deriving the player+nation join.
 */
export async function loadRefs(
  db: Db | DbTx,
  playerIds: number[],
): Promise<Map<number, PlayerRef>> {
  const refs = new Map<number, PlayerRef>();
  if (playerIds.length === 0) return refs;
  const players = await db
    .select()
    .from(player)
    .where(inArray(player.id, playerIds));
  const teamIds = Array.from(new Set(players.map((p) => p.nationalTeamId)));
  const teams =
    teamIds.length > 0
      ? await db
          .select()
          .from(nationalTeam)
          .where(inArray(nationalTeam.id, teamIds))
      : [];
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  for (const p of players) {
    refs.set(p.id, {
      playerId: p.id,
      fullName: p.fullName,
      position: p.position,
      nationalTeamId: p.nationalTeamId,
      nationalTeamName: teamName.get(p.nationalTeamId) ?? "",
    });
  }
  return refs;
}

/** The fixture ids belonging to a stage (or all fixtures when stage is omitted). */
export async function fixtureIdsForStage(
  db: Db | DbTx,
  stage?: Stage,
): Promise<number[] | null> {
  if (stage === undefined) return null; // null = "all fixtures"
  const rows = await db
    .select({ id: fixture.id })
    .from(fixture)
    .where(eq(fixture.stage, stage));
  return rows.map((r) => r.id);
}

// --- Phase 1: stage discovery -------------------------------------------------

/** The nine scoring periods in tournament order. */
export const STAGE_ORDER: readonly Stage[] = stageEnum.enumValues;
/** Position display/sort order: keeper first, then back-to-front. */
export const POSITION_ORDER: readonly Position[] = ["GK", "DEF", "MID", "FWD"];
