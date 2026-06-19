/**
 * Player Explorer (Stats Hub) - a sortable, filterable table of every player
 * with tournament data: their total fantasy points (from score_entry for a
 * ruleset) alongside their raw counting stats (from stat_line).
 *
 * Pure read, db-first. It powers the public /stats/players page where a visitor
 * can ask "highest-scoring midfielders" (filter position) or "highest-scoring
 * Spaniards" (filter nation) and sort by fantasy points or any raw stat. Points
 * come from the caller-supplied ruleset version (HUB_RULESET_VERSION on the
 * public hub); raw stats are ruleset-independent.
 *
 * Style mirrors aggregate.ts: a few bulk queries, then in-memory shaping.
 */
import { eq, inArray } from "drizzle-orm";

import type { Db, DbTx } from "../db/client.js";
import {
  nationalTeam,
  player,
  scoreEntry,
  statLine,
  type Position,
} from "../db/schema.js";

/** The columns a visitor can sort the explorer by (all descending). */
export type PlayerSortKey =
  | "points"
  | "appearances"
  | "goals"
  | "assists"
  | "saves"
  | "minutesPlayed";

export const PLAYER_SORT_KEYS: readonly PlayerSortKey[] = [
  "points",
  "appearances",
  "goals",
  "assists",
  "saves",
  "minutesPlayed",
];

export function isPlayerSortKey(raw: string): raw is PlayerSortKey {
  return (PLAYER_SORT_KEYS as readonly string[]).includes(raw);
}

export interface PlayerExplorerQuery {
  /** Ruleset version to total fantasy points against (caller-derived). */
  rulesetVersion: string;
  /** Restrict to one position; omit for all. */
  position?: Position;
  /** Restrict to one national team; omit for all. */
  nationalTeamId?: number;
  /** Sort column (descending). Default "points". */
  sort?: PlayerSortKey;
  /** Cap the result list. Default 200. */
  limit?: number;
}

/** One player's fantasy points + raw stat totals over the tournament. */
export interface PlayerExplorerRow {
  playerId: number;
  fullName: string;
  position: Position;
  nationalTeamId: number;
  nationalTeamName: string;
  /** Total fantasy points (score_entry for the ruleset), 2dp. */
  points: number;
  /** Number of fixtures the player has a score_entry for. */
  appearances: number;
  goals: number;
  assists: number;
  saves: number;
  minutesPlayed: number;
}

/** A national team that has at least one player with tournament data. */
export interface NationOption {
  nationalTeamId: number;
  name: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface Candidate {
  points: number;
  appearances: number;
  goals: number;
  assists: number;
  saves: number;
  minutesPlayed: number;
}

/**
 * Aggregate per-player points (for the ruleset) + raw stat totals. Returns a
 * map keyed by playerId over the UNION of players with a score_entry or a
 * stat_line, so a player who has raw stats but no fantasy points (or vice
 * versa) still appears with zeros in the missing column.
 */
async function loadCandidates(
  db: Db | DbTx,
  rulesetVersion: string,
): Promise<Map<number, Candidate>> {
  const map = new Map<number, Candidate>();
  const ensure = (id: number): Candidate => {
    let c = map.get(id);
    if (!c) {
      c = {
        points: 0,
        appearances: 0,
        goals: 0,
        assists: 0,
        saves: 0,
        minutesPlayed: 0,
      };
      map.set(id, c);
    }
    return c;
  };

  const scores = await db
    .select({ playerId: scoreEntry.playerId, points: scoreEntry.points })
    .from(scoreEntry)
    .where(eq(scoreEntry.rulesetVersion, rulesetVersion));
  for (const s of scores) {
    const c = ensure(s.playerId);
    c.points += s.points;
    c.appearances += 1;
  }

  const stats = await db
    .select({
      playerId: statLine.playerId,
      goals: statLine.goals,
      assists: statLine.assists,
      saves: statLine.saves,
      minutesPlayed: statLine.minutesPlayed,
    })
    .from(statLine);
  for (const st of stats) {
    const c = ensure(st.playerId);
    c.goals += st.goals;
    c.assists += st.assists;
    c.saves += st.saves;
    c.minutesPlayed += st.minutesPlayed;
  }

  return map;
}

function metric(c: Candidate, key: PlayerSortKey): number {
  switch (key) {
    case "points":
      return c.points;
    case "appearances":
      return c.appearances;
    case "goals":
      return c.goals;
    case "assists":
      return c.assists;
    case "saves":
      return c.saves;
    case "minutesPlayed":
      return c.minutesPlayed;
  }
}

/**
 * The Player Explorer table: every player with tournament data, optionally
 * filtered by position and/or nation, sorted by the chosen column (descending;
 * ties broken by fantasy points then playerId), capped to `limit`.
 */
export async function playerExplorer(
  db: Db | DbTx,
  query: PlayerExplorerQuery,
): Promise<PlayerExplorerRow[]> {
  const sort: PlayerSortKey = query.sort ?? "points";
  const limit = query.limit ?? 200;

  const candidates = await loadCandidates(db, query.rulesetVersion);
  if (candidates.size === 0) return [];

  const players = await db
    .select({
      id: player.id,
      fullName: player.fullName,
      position: player.position,
      nationalTeamId: player.nationalTeamId,
    })
    .from(player)
    .where(inArray(player.id, Array.from(candidates.keys())));

  const teamIds = Array.from(new Set(players.map((p) => p.nationalTeamId)));
  const teams =
    teamIds.length > 0
      ? await db
          .select()
          .from(nationalTeam)
          .where(inArray(nationalTeam.id, teamIds))
      : [];
  const teamName = new Map(teams.map((t) => [t.id, t.name]));

  const rows: PlayerExplorerRow[] = [];
  for (const p of players) {
    if (query.position && p.position !== query.position) continue;
    if (
      query.nationalTeamId !== undefined &&
      p.nationalTeamId !== query.nationalTeamId
    ) {
      continue;
    }
    const c = candidates.get(p.id);
    if (!c) continue;
    rows.push({
      playerId: p.id,
      fullName: p.fullName,
      position: p.position,
      nationalTeamId: p.nationalTeamId,
      nationalTeamName: teamName.get(p.nationalTeamId) ?? "",
      points: round2(c.points),
      appearances: c.appearances,
      goals: c.goals,
      assists: c.assists,
      saves: c.saves,
      minutesPlayed: c.minutesPlayed,
    });
  }

  rows.sort((a, b) => {
    const am = metric(candidates.get(a.playerId)!, sort);
    const bm = metric(candidates.get(b.playerId)!, sort);
    return bm - am || b.points - a.points || a.playerId - b.playerId;
  });

  return rows.slice(0, limit);
}

/**
 * The national teams that have at least one player with tournament data, for
 * the explorer's nation filter. Sorted by name.
 */
export async function playerExplorerNations(
  db: Db | DbTx,
  rulesetVersion: string,
): Promise<NationOption[]> {
  const candidates = await loadCandidates(db, rulesetVersion);
  if (candidates.size === 0) return [];

  const players = await db
    .select({ id: player.id, nationalTeamId: player.nationalTeamId })
    .from(player)
    .where(inArray(player.id, Array.from(candidates.keys())));
  const teamIds = Array.from(new Set(players.map((p) => p.nationalTeamId)));
  if (teamIds.length === 0) return [];

  const teams = await db
    .select()
    .from(nationalTeam)
    .where(inArray(nationalTeam.id, teamIds));
  const options = teams.map((t) => ({ nationalTeamId: t.id, name: t.name }));
  options.sort((a, b) => a.name.localeCompare(b.name) || a.nationalTeamId - b.nationalTeamId);
  return options;
}
