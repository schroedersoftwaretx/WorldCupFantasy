/**
 * Per-period roster reconstruction (Priority 5).
 *
 * roster_slot is the CURRENT roster; roster_transaction is the append-only
 * movement ledger. The roster a team had DURING scoring period P is obtained
 * by starting from the current roster and REVERSING, newest first, every
 * ledger row whose effective_ordinal is greater than P's ordinal:
 *
 *   - a movement TO the team that isn't effective yet at P -> player wasn't
 *     there: remove him;
 *   - a movement OFF the team that isn't effective yet at P -> player was
 *     still there: put him back.
 *
 * Kept separate from service.ts so standings can import it without pulling
 * in the write paths (service.ts imports standings for waiver priority -
 * this split breaks the cycle).
 *
 * Pure helpers + one read; no HTTP/auth/env here.
 */
import { asc, eq } from "drizzle-orm";

import type { Db, DbTx } from "../db/client.js";
import {
  rosterTransaction,
  type RosterTransactionRow,
} from "../db/schema.js";

/** All ledger rows for a league, oldest first. Empty for flag-off leagues. */
export async function getLedger(
  db: Db | DbTx,
  leagueId: number,
): Promise<RosterTransactionRow[]> {
  return db
    .select()
    .from(rosterTransaction)
    .where(eq(rosterTransaction.leagueId, leagueId))
    .orderBy(asc(rosterTransaction.id));
}

/**
 * The player ids team `fantasyTeamId` had during period `ordinal`, given its
 * CURRENT ids and the league ledger (oldest first). Pure.
 */
export function rosterAtOrdinal(
  currentPlayerIds: readonly number[],
  fantasyTeamId: number,
  ledgerOldestFirst: readonly RosterTransactionRow[],
  ordinal: number,
): number[] {
  const set = new Set(currentPlayerIds);
  // Reverse newest-first; only rows not yet effective at `ordinal` unwind.
  for (let i = ledgerOldestFirst.length - 1; i >= 0; i -= 1) {
    const row = ledgerOldestFirst[i]!;
    if (row.effectiveOrdinal <= ordinal) continue;
    if (row.toFantasyTeamId === fantasyTeamId) set.delete(row.playerId);
    if (row.fromFantasyTeamId === fantasyTeamId) set.add(row.playerId);
  }
  return Array.from(set);
}

/**
 * Every player id that was EVER on `fantasyTeamId` per the current roster
 * plus the ledger - the id universe standings must load stats for. Pure.
 */
export function everRosteredPlayerIds(
  currentPlayerIds: readonly number[],
  fantasyTeamId: number,
  ledger: readonly RosterTransactionRow[],
): number[] {
  const set = new Set(currentPlayerIds);
  for (const row of ledger) {
    if (
      row.fromFantasyTeamId === fantasyTeamId ||
      row.toFantasyTeamId === fantasyTeamId
    ) {
      set.add(row.playerId);
    }
  }
  return Array.from(set);
}
