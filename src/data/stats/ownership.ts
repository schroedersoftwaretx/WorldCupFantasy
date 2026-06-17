/**
 * Cross-league ownership (Phase 2.1).
 *
 * In a draft league a real player is rostered at most once per league
 * (the unique (league_id, player_id) on roster_slot), so "ownership %" only
 * becomes meaningful ACROSS leagues. This service answers, for every player,
 * how many distinct fantasy teams (across all leagues) roster them, and what
 * fraction of all fantasy teams that is.
 *
 * Privacy/fairness: this is a pure AGGREGATE. It exposes only counts and a
 * percentage, never which specific team in which league owns a player, so it
 * cannot be used to scout a rival roster in another league.
 *
 * Pure read over roster_slot + fantasy_team + league. No writes. Style mirrors
 * aggregate.ts: a few bulk queries, then in-memory aggregation.
 */
import { inArray } from "drizzle-orm";

import type { Db, DbTx } from "../db/client.js";
import {
  fantasyTeam,
  league,
  rosterSlot,
  type LeagueStatus,
} from "../db/schema.js";
import { loadRefs, type PlayerRef } from "./aggregate.js";

/** League statuses that count as "has finished drafting". */
const FINISHED_DRAFT_STATUSES: readonly LeagueStatus[] = ["ACTIVE", "COMPLETE"];

export interface OwnershipOptions {
  /**
   * Restrict the numerator AND denominator to leagues whose draft has
   * finished (status ACTIVE or COMPLETE), giving a cleaner percentage that
   * ignores half-finished SETUP/DRAFTING leagues. Default true.
   */
  finishedDraftsOnly?: boolean;
}

/** One player's global ownership across the eligible leagues. */
export interface PlayerOwnership extends PlayerRef {
  /** Distinct fantasy teams (across eligible leagues) rostering this player. */
  ownedCount: number;
  /** ownedCount / totalFantasyTeams, in [0,1], rounded to 4dp. 0 when none. */
  ownershipPct: number;
}

export interface OwnershipResult {
  /** Denominator: fantasy teams in the eligible leagues. */
  totalFantasyTeams: number;
  /** Owned players (ownedCount >= 1), sorted most-owned first. */
  players: PlayerOwnership[];
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** The ids of leagues eligible for ownership, honouring finishedDraftsOnly. */
async function eligibleLeagueIds(
  db: Db | DbTx,
  finishedDraftsOnly: boolean,
): Promise<number[]> {
  const rows = await db.select({ id: league.id, status: league.status }).from(league);
  const finished = new Set<string>(FINISHED_DRAFT_STATUSES);
  return rows
    .filter((r) => !finishedDraftsOnly || finished.has(r.status))
    .map((r) => r.id);
}

interface OwnershipAggregate {
  totalFantasyTeams: number;
  /** playerId -> set of distinct fantasy team ids rostering them. */
  teamsByPlayer: Map<number, Set<number>>;
}

/** Core aggregation shared by the list and single-player entry points. */
async function aggregate(
  db: Db | DbTx,
  options: OwnershipOptions,
): Promise<OwnershipAggregate> {
  const finishedDraftsOnly = options.finishedDraftsOnly ?? true;
  const leagueIds = await eligibleLeagueIds(db, finishedDraftsOnly);
  if (leagueIds.length === 0) {
    return { totalFantasyTeams: 0, teamsByPlayer: new Map() };
  }

  const teams = await db
    .select({ id: fantasyTeam.id })
    .from(fantasyTeam)
    .where(inArray(fantasyTeam.leagueId, leagueIds));
  const totalFantasyTeams = teams.length;

  const slots = await db
    .select({
      playerId: rosterSlot.playerId,
      fantasyTeamId: rosterSlot.fantasyTeamId,
    })
    .from(rosterSlot)
    .where(inArray(rosterSlot.leagueId, leagueIds));

  const teamsByPlayer = new Map<number, Set<number>>();
  for (const s of slots) {
    const set = teamsByPlayer.get(s.playerId) ?? new Set<number>();
    set.add(s.fantasyTeamId);
    teamsByPlayer.set(s.playerId, set);
  }
  return { totalFantasyTeams, teamsByPlayer };
}

/**
 * Global ownership for every owned player. Sorted by ownedCount desc, then
 * ownershipPct desc, then playerId asc.
 */
export async function globalOwnership(
  db: Db | DbTx,
  options: OwnershipOptions = {},
): Promise<OwnershipResult> {
  const { totalFantasyTeams, teamsByPlayer } = await aggregate(db, options);
  const refs = await loadRefs(db, Array.from(teamsByPlayer.keys()));

  const players: PlayerOwnership[] = [];
  for (const [playerId, teams] of teamsByPlayer) {
    const ref = refs.get(playerId);
    if (!ref) continue;
    const ownedCount = teams.size;
    const ownershipPct =
      totalFantasyTeams > 0 ? round4(ownedCount / totalFantasyTeams) : 0;
    players.push({ ...ref, ownedCount, ownershipPct });
  }
  players.sort(
    (a, b) =>
      b.ownedCount - a.ownedCount ||
      b.ownershipPct - a.ownershipPct ||
      a.playerId - b.playerId,
  );
  return { totalFantasyTeams, players };
}

/** One player's ownership figure (for the modal / per-player surfaces). */
export interface SinglePlayerOwnership {
  ownedCount: number;
  ownershipPct: number;
  totalFantasyTeams: number;
}

/**
 * Ownership for a single player. Returns zeros (with the real denominator)
 * when the player is rostered nowhere.
 */
export async function ownershipForPlayer(
  db: Db | DbTx,
  playerId: number,
  options: OwnershipOptions = {},
): Promise<SinglePlayerOwnership> {
  const { totalFantasyTeams, teamsByPlayer } = await aggregate(db, options);
  const ownedCount = teamsByPlayer.get(playerId)?.size ?? 0;
  const ownershipPct =
    totalFantasyTeams > 0 ? round4(ownedCount / totalFantasyTeams) : 0;
  return { ownedCount, ownershipPct, totalFantasyTeams };
}

/**
 * Ownership as a plain map (playerId -> ownedCount/pct), plus the denominator.
 * Convenience for surfaces that annotate an existing player list (the public
 * Draft Trends table, the Stats Hub leaderboards, the draft board).
 */
export async function ownershipByPlayerId(
  db: Db | DbTx,
  options: OwnershipOptions = {},
): Promise<{
  totalFantasyTeams: number;
  byPlayerId: Map<number, { ownedCount: number; ownershipPct: number }>;
}> {
  const { totalFantasyTeams, teamsByPlayer } = await aggregate(db, options);
  const byPlayerId = new Map<
    number,
    { ownedCount: number; ownershipPct: number }
  >();
  for (const [playerId, teams] of teamsByPlayer) {
    const ownedCount = teams.size;
    const ownershipPct =
      totalFantasyTeams > 0 ? round4(ownedCount / totalFantasyTeams) : 0;
    byPlayerId.set(playerId, { ownedCount, ownershipPct });
  }
  return { totalFantasyTeams, byPlayerId };
}
