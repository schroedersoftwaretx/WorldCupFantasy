/**
 * Roster service (Phase 3).
 *
 * The one write operation is addPlayerToRoster: it places a real player on
 * a manager's fantasy_team after checking, in a single transaction:
 *
 *   1. the fantasy_team and player exist,
 *   2. the player belongs to no roster in this league yet (each real
 *      player is draftable exactly once per league - enforced both here
 *      and by a DB unique constraint as a backstop),
 *   3. adding the player keeps the roster legal: it does not exceed the
 *      position's draft cap, and it does not make a complete 23-man roster
 *      impossible (the roster validator's completability check).
 *
 * addPlayerToRosterTx is the same logic against an existing transaction:
 * Phase 4's draft service composes it into the larger "make a pick"
 * transaction so a pick and its roster slot commit atomically.
 *
 * Read helpers (getRosterCounts, getRoster, validateRoster) are also
 * provided.
 */

import { and, eq } from "drizzle-orm";

import type { Db, DbTx } from "../db/client.js";
import {
  fantasyTeam,
  player,
  rosterSlot,
  type PlayerRow,
  type Position,
  type RosterSlotRow,
} from "../db/schema.js";
import { RosterError } from "../league/errors.js";
import {
  ROSTER_REQUIREMENTS,
  canAddPlayer,
  countsFromPositions,
  validateCompleteRoster,
  type PositionCounts,
  type RosterRequirements,
  type ValidationResult,
} from "./validator.js";

export interface AddPlayerToRosterInput {
  fantasyTeamId: number;
  playerId: number;
}

export interface AddPlayerToRosterResult {
  slot: RosterSlotRow;
  /** Position counts AFTER the add. */
  counts: PositionCounts;
}

/**
 * Core roster-add logic against an existing transaction. Throws
 * RosterError on any rule violation.
 */
export async function addPlayerToRosterTx(
  tx: DbTx,
  input: AddPlayerToRosterInput,
  reqs: RosterRequirements = ROSTER_REQUIREMENTS,
): Promise<AddPlayerToRosterResult> {
  const [team] = await tx
    .select()
    .from(fantasyTeam)
    .where(eq(fantasyTeam.id, input.fantasyTeamId));
  if (!team) {
    throw new RosterError(
      `fantasy team ${input.fantasyTeamId} does not exist`,
      "TEAM_NOT_FOUND",
    );
  }

  const [draftee] = await tx
    .select()
    .from(player)
    .where(eq(player.id, input.playerId));
  if (!draftee) {
    throw new RosterError(`player ${input.playerId} does not exist`, "PLAYER_NOT_FOUND");
  }

  // Each real player may be drafted at most once per league.
  const sameLeagueSlot = await tx
    .select()
    .from(rosterSlot)
    .where(
      and(eq(rosterSlot.leagueId, team.leagueId), eq(rosterSlot.playerId, draftee.id)),
    );
  if (sameLeagueSlot[0]) {
    throw new RosterError(
      `player ${draftee.fullName} is already drafted in this league`,
      "PLAYER_ALREADY_DRAFTED",
    );
  }

  // Current roster composition for this team.
  const existing = await tx
    .select({ position: rosterSlot.draftedPosition })
    .from(rosterSlot)
    .where(eq(rosterSlot.fantasyTeamId, team.id));
  const counts = countsFromPositions(existing.map((r) => r.position));

  // Legality: cap + completability.
  const check = canAddPlayer(counts, draftee.position, reqs);
  if (!check.ok) {
    throw new RosterError(
      check.reason ?? "roster rule violation",
      "ROSTER_RULE_VIOLATION",
    );
  }

  const [slot] = await tx
    .insert(rosterSlot)
    .values({
      fantasyTeamId: team.id,
      playerId: draftee.id,
      leagueId: team.leagueId,
      draftedPosition: draftee.position,
    })
    .returning();
  if (!slot) throw new RosterError("roster slot insert failed", "SLOT_INSERT_FAILED");

  const nextCounts: PositionCounts = {
    ...counts,
    [draftee.position]: counts[draftee.position] + 1,
  };
  return { slot, counts: nextCounts };
}

/**
 * Draft a player onto a fantasy_team in its own transaction. Throws
 * RosterError if any rule is violated; on success returns the new
 * roster_slot and updated counts.
 */
export async function addPlayerToRoster(
  db: Db,
  input: AddPlayerToRosterInput,
  reqs: RosterRequirements = ROSTER_REQUIREMENTS,
): Promise<AddPlayerToRosterResult> {
  return db.transaction((tx) => addPlayerToRosterTx(tx, input, reqs));
}

// --- read helpers -----------------------------------------------------------

/** Position counts for one fantasy_team. */
export async function getRosterCounts(
  db: Db,
  fantasyTeamId: number,
): Promise<PositionCounts> {
  const rows = await db
    .select({ position: rosterSlot.draftedPosition })
    .from(rosterSlot)
    .where(eq(rosterSlot.fantasyTeamId, fantasyTeamId));
  return countsFromPositions(rows.map((r) => r.position));
}

export interface RosterEntry {
  slot: RosterSlotRow;
  player: PlayerRow;
}

/** Full roster (slots joined to players) for one fantasy_team. */
export async function getRoster(
  db: Db,
  fantasyTeamId: number,
): Promise<RosterEntry[]> {
  const rows = await db
    .select()
    .from(rosterSlot)
    .innerJoin(player, eq(player.id, rosterSlot.playerId))
    .where(eq(rosterSlot.fantasyTeamId, fantasyTeamId));
  return rows.map((r) => ({ slot: r.roster_slot, player: r.player }));
}

/**
 * Validate that a fantasy_team currently holds a legal COMPLETE 23-man
 * roster. Useful as a post-draft assertion in Phase 4.
 */
export async function validateRoster(
  db: Db,
  fantasyTeamId: number,
  reqs: RosterRequirements = ROSTER_REQUIREMENTS,
): Promise<ValidationResult> {
  const counts = await getRosterCounts(db, fantasyTeamId);
  return validateCompleteRoster(counts, reqs);
}

/** Re-export so Phase 4 can import position typing from one place. */
export type { Position };
