/**
 * Draft pick-queue service (Phase 8).
 *
 * A manager pre-ranks the players they want; when the timer auto-picks for
 * their team, the autopick prefers the highest-ranked queued player that is
 * still available and a legal roster addition (see `chooseAutopick` /
 * `selectQueuedCandidate`), falling back to `draft_rank` otherwise.
 *
 * Ranks are stored contiguous (1..n) per (draft_room, fantasy_team); lower
 * rank = higher priority. Pure service: takes a `Db`/`DbTx` first and plain
 * inputs. It never touches snake order, the pick timer, or the score spine.
 */
import { and, asc, eq, sql } from "drizzle-orm";

import type { Db, DbTx } from "../db/client.js";
import {
  draftQueue,
  player,
  rosterSlot,
  type Position,
} from "../db/schema.js";

/** One entry in a team's draft queue, enriched for the UI. */
export interface QueueEntry {
  playerId: number;
  rank: number;
  fullName: string;
  position: Position;
  /** False once the player has been drafted by anyone in the league. */
  available: boolean;
}

/**
 * The ordered player IDs in a team's queue (rank ascending = priority order).
 * This is what the autopick consults. Cheap and id-only.
 */
export async function queuedPlayerIds(
  db: Db | DbTx,
  draftRoomId: number,
  fantasyTeamId: number,
): Promise<number[]> {
  const rows = await db
    .select({ playerId: draftQueue.playerId, rank: draftQueue.rank })
    .from(draftQueue)
    .where(
      and(
        eq(draftQueue.draftRoomId, draftRoomId),
        eq(draftQueue.fantasyTeamId, fantasyTeamId),
      ),
    )
    .orderBy(asc(draftQueue.rank));
  return rows.map((r) => r.playerId);
}

/**
 * The team's queue with player names/positions and an availability flag, for
 * rendering. `leagueId` is used to mark already-drafted players.
 */
export async function getQueue(
  db: Db | DbTx,
  draftRoomId: number,
  fantasyTeamId: number,
  leagueId: number,
): Promise<QueueEntry[]> {
  const rows = await db
    .select({
      playerId: draftQueue.playerId,
      rank: draftQueue.rank,
      fullName: player.fullName,
      position: player.position,
    })
    .from(draftQueue)
    .innerJoin(player, eq(player.id, draftQueue.playerId))
    .where(
      and(
        eq(draftQueue.draftRoomId, draftRoomId),
        eq(draftQueue.fantasyTeamId, fantasyTeamId),
      ),
    )
    .orderBy(asc(draftQueue.rank));

  const taken = await db
    .select({ playerId: rosterSlot.playerId })
    .from(rosterSlot)
    .where(eq(rosterSlot.leagueId, leagueId));
  const takenIds = new Set(taken.map((t) => t.playerId));

  return rows.map((r) => ({
    playerId: r.playerId,
    rank: r.rank,
    fullName: r.fullName,
    position: r.position,
    available: !takenIds.has(r.playerId),
  }));
}

/**
 * Append a player to the end of a team's queue. Idempotent: a no-op if the
 * player is already queued. Returns the updated queue.
 */
export async function addToQueue(
  db: Db | DbTx,
  draftRoomId: number,
  fantasyTeamId: number,
  playerId: number,
  leagueId: number,
): Promise<QueueEntry[]> {
  const [{ maxRank } = { maxRank: 0 }] = await db
    .select({
      maxRank: sql<number>`coalesce(max(${draftQueue.rank}), 0)`,
    })
    .from(draftQueue)
    .where(
      and(
        eq(draftQueue.draftRoomId, draftRoomId),
        eq(draftQueue.fantasyTeamId, fantasyTeamId),
      ),
    );

  await db
    .insert(draftQueue)
    .values({ draftRoomId, fantasyTeamId, playerId, rank: Number(maxRank) + 1 })
    .onConflictDoNothing({
      target: [
        draftQueue.draftRoomId,
        draftQueue.fantasyTeamId,
        draftQueue.playerId,
      ],
    });

  return getQueue(db, draftRoomId, fantasyTeamId, leagueId);
}

/**
 * Remove a player from a team's queue and re-pack the remaining ranks to stay
 * contiguous (1..n). Returns the updated queue.
 */
export async function removeFromQueue(
  db: Db | DbTx,
  draftRoomId: number,
  fantasyTeamId: number,
  playerId: number,
  leagueId: number,
): Promise<QueueEntry[]> {
  await db
    .delete(draftQueue)
    .where(
      and(
        eq(draftQueue.draftRoomId, draftRoomId),
        eq(draftQueue.fantasyTeamId, fantasyTeamId),
        eq(draftQueue.playerId, playerId),
      ),
    );
  await repackRanks(db, draftRoomId, fantasyTeamId);
  return getQueue(db, draftRoomId, fantasyTeamId, leagueId);
}

/**
 * Replace the queue ordering with an explicit player-id order. Any player id
 * not currently in the queue is ignored; any queued player omitted from
 * `orderedPlayerIds` is appended after, preserving its prior relative order, so
 * a partial reorder (e.g. "move this one up") is safe. Returns the new queue.
 */
export async function reorderQueue(
  db: Db | DbTx,
  draftRoomId: number,
  fantasyTeamId: number,
  orderedPlayerIds: readonly number[],
  leagueId: number,
): Promise<QueueEntry[]> {
  const current = await queuedPlayerIds(db, draftRoomId, fantasyTeamId);
  const currentSet = new Set(current);
  const seen = new Set<number>();
  const next: number[] = [];
  for (const id of orderedPlayerIds) {
    if (currentSet.has(id) && !seen.has(id)) {
      next.push(id);
      seen.add(id);
    }
  }
  // Preserve any queued players the caller left out, in their prior order.
  for (const id of current) {
    if (!seen.has(id)) next.push(id);
  }

  for (let i = 0; i < next.length; i += 1) {
    await db
      .update(draftQueue)
      .set({ rank: i + 1 })
      .where(
        and(
          eq(draftQueue.draftRoomId, draftRoomId),
          eq(draftQueue.fantasyTeamId, fantasyTeamId),
          eq(draftQueue.playerId, next[i]!),
        ),
      );
  }
  return getQueue(db, draftRoomId, fantasyTeamId, leagueId);
}

/** Re-number a team's queue ranks to 1..n in current rank order. */
async function repackRanks(
  db: Db | DbTx,
  draftRoomId: number,
  fantasyTeamId: number,
): Promise<void> {
  const ids = await queuedPlayerIds(db, draftRoomId, fantasyTeamId);
  for (let i = 0; i < ids.length; i += 1) {
    await db
      .update(draftQueue)
      .set({ rank: i + 1 })
      .where(
        and(
          eq(draftQueue.draftRoomId, draftRoomId),
          eq(draftQueue.fantasyTeamId, fantasyTeamId),
          eq(draftQueue.playerId, ids[i]!),
        ),
      );
  }
}
