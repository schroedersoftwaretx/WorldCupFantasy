/**
 * Average Draft Position & draft analytics (Phase 2.2).
 *
 * Pure read over draft_pick (the append-only pick log) + player.draft_rank.
 * For every player taken in at least one draft it computes:
 *   - adp          mean overall pick_number across drafts where taken
 *   - earliest/latest pick number
 *   - timesPicked  how many drafts took them
 *   - takeRate     timesPicked / total drafts considered
 *   - reachSteal   adp - draft_rank (NEGATIVE = drafted EARLIER than their
 *                  pre-tournament rank, i.e. a "reach"; positive = a "steal"
 *                  that fell past their rank). Null when the player is unranked.
 *
 * Privacy/fairness: like ownership this is a cross-league AGGREGATE; it never
 * reveals which league or team made a given pick.
 *
 * "Drafts considered" are the drafts that have actually begun (have >= 1 pick),
 * or only COMPLETE drafts when completedDraftsOnly is set, so the take-rate
 * denominator is well-defined.
 */
import { eq, inArray } from "drizzle-orm";

import type { Db, DbTx } from "../db/client.js";
import {
  draftPick,
  draftRoom,
  player,
  type DraftStatus,
} from "../db/schema.js";
import { loadRefs, type PlayerRef } from "./aggregate.js";

export interface AdpOptions {
  /**
   * Only consider COMPLETE drafts (every pick made) when computing ADP and the
   * take-rate denominator. Default false: any draft that has begun counts.
   */
  completedDraftsOnly?: boolean;
}

/** One player's ADP / draft analytics across the considered drafts. */
export interface PlayerAdp extends PlayerRef {
  /** Mean overall pick number across drafts where taken, rounded to 2dp. */
  adp: number;
  /** Lowest (earliest) overall pick number the player went at. */
  earliestPick: number;
  /** Highest (latest) overall pick number the player went at. */
  latestPick: number;
  /** Number of considered drafts in which the player was taken. */
  timesPicked: number;
  /** timesPicked / totalDrafts, in [0,1], rounded to 4dp. */
  takeRate: number;
  /** Pre-tournament big-board rank (lower = better), or null when unranked. */
  draftRank: number | null;
  /**
   * adp - draftRank. Negative => drafted earlier than rank (a reach); positive
   * => fell past their rank (a steal). Null when the player is unranked.
   */
  reachSteal: number | null;
}

export interface AdpResult {
  /** Denominator for take-rate: the number of drafts considered. */
  totalDrafts: number;
  /** Players taken in >= 1 considered draft, sorted by ADP ascending. */
  players: PlayerAdp[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

interface AdpAccumulator {
  /** distinct draftRoomIds the player was taken in. */
  drafts: Set<number>;
  sumPick: number;
  count: number;
  earliest: number;
  latest: number;
}

interface AdpAggregate {
  totalDrafts: number;
  byPlayer: Map<number, AdpAccumulator>;
}

/** Core aggregation shared by the list and per-player/map entry points. */
async function aggregate(
  db: Db | DbTx,
  options: AdpOptions,
): Promise<AdpAggregate> {
  const completedOnly = options.completedDraftsOnly ?? false;

  // Which draft rooms are eligible.
  const rooms = await db
    .select({ id: draftRoom.id, status: draftRoom.status })
    .from(draftRoom);
  const completeStatuses = new Set<DraftStatus>(["COMPLETE"]);
  const eligibleRoomIds = rooms
    .filter((r) => !completedOnly || completeStatuses.has(r.status))
    .map((r) => r.id);

  if (eligibleRoomIds.length === 0) {
    return { totalDrafts: 0, byPlayer: new Map() };
  }

  const picks = await db
    .select({
      draftRoomId: draftPick.draftRoomId,
      playerId: draftPick.playerId,
      pickNumber: draftPick.pickNumber,
    })
    .from(draftPick)
    .where(inArray(draftPick.draftRoomId, eligibleRoomIds));

  // "Drafts considered" = eligible rooms that actually have >= 1 pick, so a
  // freshly-created-but-not-started room never dilutes the take-rate.
  const roomsWithPicks = new Set<number>(picks.map((p) => p.draftRoomId));
  const totalDrafts = roomsWithPicks.size;

  const byPlayer = new Map<number, AdpAccumulator>();
  for (const p of picks) {
    const acc = byPlayer.get(p.playerId) ?? {
      drafts: new Set<number>(),
      sumPick: 0,
      count: 0,
      earliest: p.pickNumber,
      latest: p.pickNumber,
    };
    acc.drafts.add(p.draftRoomId);
    acc.sumPick += p.pickNumber;
    acc.count += 1;
    acc.earliest = Math.min(acc.earliest, p.pickNumber);
    acc.latest = Math.max(acc.latest, p.pickNumber);
    byPlayer.set(p.playerId, acc);
  }
  return { totalDrafts, byPlayer };
}

/** Pre-tournament draft_rank for a set of player ids (null when unranked). */
async function draftRanks(
  db: Db | DbTx,
  playerIds: number[],
): Promise<Map<number, number | null>> {
  const map = new Map<number, number | null>();
  if (playerIds.length === 0) return map;
  const rows = await db
    .select({ id: player.id, draftRank: player.draftRank })
    .from(player)
    .where(inArray(player.id, playerIds));
  for (const r of rows) {
    // Treat 0 as "unranked" to match the draft board / autopick convention.
    map.set(r.id, r.draftRank && r.draftRank > 0 ? r.draftRank : null);
  }
  return map;
}

function toPlayerAdp(
  ref: PlayerRef,
  acc: AdpAccumulator,
  totalDrafts: number,
  rank: number | null,
): PlayerAdp {
  const adp = round2(acc.sumPick / acc.count);
  const takeRate = totalDrafts > 0 ? round4(acc.drafts.size / totalDrafts) : 0;
  return {
    ...ref,
    adp,
    earliestPick: acc.earliest,
    latestPick: acc.latest,
    timesPicked: acc.drafts.size,
    takeRate,
    draftRank: rank,
    reachSteal: rank !== null ? round2(adp - rank) : null,
  };
}

/**
 * ADP / draft analytics for every drafted player, sorted by ADP ascending
 * (earliest off the board first), then by playerId.
 */
export async function globalAdp(
  db: Db | DbTx,
  options: AdpOptions = {},
): Promise<AdpResult> {
  const { totalDrafts, byPlayer } = await aggregate(db, options);
  const playerIds = Array.from(byPlayer.keys());
  const refs = await loadRefs(db, playerIds);
  const ranks = await draftRanks(db, playerIds);

  const players: PlayerAdp[] = [];
  for (const [playerId, acc] of byPlayer) {
    const ref = refs.get(playerId);
    if (!ref) continue;
    players.push(toPlayerAdp(ref, acc, totalDrafts, ranks.get(playerId) ?? null));
  }
  players.sort((a, b) => a.adp - b.adp || a.playerId - b.playerId);
  return { totalDrafts, players };
}

/**
 * ADP as a plain map (playerId -> adp figure), plus the denominator. For
 * surfaces that annotate an existing player list (Draft Trends, Stats Hub
 * leaderboards, the live draft board overlay).
 */
export async function adpByPlayerId(
  db: Db | DbTx,
  options: AdpOptions = {},
): Promise<{ totalDrafts: number; byPlayerId: Map<number, PlayerAdp> }> {
  const { totalDrafts, byPlayer } = await aggregate(db, options);
  const playerIds = Array.from(byPlayer.keys());
  const refs = await loadRefs(db, playerIds);
  const ranks = await draftRanks(db, playerIds);
  const byPlayerId = new Map<number, PlayerAdp>();
  for (const [playerId, acc] of byPlayer) {
    const ref = refs.get(playerId);
    if (!ref) continue;
    byPlayerId.set(
      playerId,
      toPlayerAdp(ref, acc, totalDrafts, ranks.get(playerId) ?? null),
    );
  }
  return { totalDrafts, byPlayerId };
}
