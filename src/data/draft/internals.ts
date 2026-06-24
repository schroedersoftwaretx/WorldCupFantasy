/**
 * Async snake-draft state machine - internal helpers.
 *
 * These are the transaction-scoped building blocks behind the public
 * operations in `./commands.ts`: loading rooms/order, resolving who is on
 * the clock, applying a pick (roster slot + draft_pick + advance), choosing
 * an autopick, and emitting the PENDING notification rows.
 *
 * The in-transaction notification emitters (emitNotification,
 * emitToAllManagers, emitOnTheClock) live here rather than in
 * `./notifications.ts` because `applyPick` calls them while they in turn
 * call `teamOnClock`/`addHours` - co-locating that tightly-coupled pair
 * avoids a circular import between the two modules. The best-effort delivery
 * path (`deliverPending`) has no such coupling and stays in
 * `./notifications.ts`.
 */

import { asc, eq } from "drizzle-orm";

import type { Db, DbTx } from "../db/client.js";
import {
  draftNotification,
  draftOrder,
  draftPick,
  draftRoom,
  fantasyTeam,
  league,
  leagueMembership,
  player,
  rosterSlot,
  type DraftNotificationType,
  type DraftRoomRow,
  type LeagueRow,
} from "../db/schema.js";
import { DraftError } from "../league/errors.js";
import { addPlayerToRosterTx } from "../roster/service.js";
import { countsFromPositions, ROSTER_REQUIREMENTS } from "../roster/validator.js";
import { chooseAutopick, type AutopickCandidate } from "./autopick.js";
import type { MakePickResult } from "./commands.js";
import { queuedPlayerIds } from "./queue.js";
import { roundForPick, slotForPick } from "./snake.js";

// --- room / order ----------------------------------------------------------

export async function loadRoom(tx: DbTx | Db, draftRoomId: number): Promise<DraftRoomRow> {
  const [r] = await tx.select().from(draftRoom).where(eq(draftRoom.id, draftRoomId));
  if (!r) throw new DraftError(`draft room ${draftRoomId} not found`, "DRAFT_NOT_FOUND");
  return r;
}

/** Round-1 team order: index 0 is slot 1. */
export async function loadOrder(tx: DbTx | Db, draftRoomId: number): Promise<number[]> {
  const rows = await tx
    .select()
    .from(draftOrder)
    .where(eq(draftOrder.draftRoomId, draftRoomId))
    .orderBy(asc(draftOrder.slot));
  return rows.map((r) => r.fantasyTeamId);
}

export function requireInProgress(r: DraftRoomRow): void {
  if (r.status !== "IN_PROGRESS") {
    throw new DraftError(`draft is ${r.status}, not in progress`, "DRAFT_NOT_IN_PROGRESS");
  }
  if (r.currentPickNumber === null) {
    throw new DraftError("draft has no current pick", "NO_CURRENT_PICK");
  }
}

interface OnClock {
  pickNumber: number;
  round: number;
  slot: number;
  fantasyTeamId: number;
}

/** Who is on the clock for a draft's current pick. */
export function teamOnClock(r: DraftRoomRow, order: number[]): OnClock {
  if (r.currentPickNumber === null) {
    throw new DraftError("draft has no current pick", "NO_CURRENT_PICK");
  }
  const n = order.length;
  const slot = slotForPick(r.currentPickNumber, n);
  const fantasyTeamId = order[slot - 1];
  if (fantasyTeamId === undefined) {
    throw new DraftError("draft order is inconsistent", "BAD_DRAFT_ORDER");
  }
  return {
    pickNumber: r.currentPickNumber,
    round: roundForPick(r.currentPickNumber, n),
    slot,
    fantasyTeamId,
  };
}

interface ApplyPickInput {
  fantasyTeamId: number;
  playerId: number;
  isAutopick: boolean;
  now: Date;
}

/**
 * Place a pick: write the roster slot, record the draft_pick, and advance
 * the draft - all within the caller's transaction.
 */
export async function applyPick(
  tx: DbTx,
  r: DraftRoomRow,
  order: number[],
  input: ApplyPickInput,
): Promise<MakePickResult> {
  if (r.currentPickNumber === null) {
    throw new DraftError("draft has no current pick", "NO_CURRENT_PICK");
  }
  const n = order.length;
  const pickNumber = r.currentPickNumber;
  const round = roundForPick(pickNumber, n);

  // Roster legality (cap + completability + per-league uniqueness) is
  // enforced here; an illegal pick throws RosterError and aborts the tx.
  await addPlayerToRosterTx(tx, {
    fantasyTeamId: input.fantasyTeamId,
    playerId: input.playerId,
  });

  await tx.insert(draftPick).values({
    draftRoomId: r.id,
    pickNumber,
    round,
    fantasyTeamId: input.fantasyTeamId,
    playerId: input.playerId,
    isAutopick: input.isAutopick,
    pickedAt: input.now,
  });

  const [lg] = await tx.select().from(league).where(eq(league.id, r.leagueId));
  if (!lg) throw new DraftError("league missing", "LEAGUE_NOT_FOUND");

  const nextPick = pickNumber + 1;
  let updatedRoom: DraftRoomRow;

  if (nextPick > r.totalPicks) {
    // Draft complete.
    const [done] = await tx
      .update(draftRoom)
      .set({
        status: "COMPLETE",
        currentPickNumber: null,
        currentPickDeadline: null,
        completedAt: input.now,
        updatedAt: input.now,
      })
      .where(eq(draftRoom.id, r.id))
      .returning();
    if (!done) throw new DraftError("draft update failed", "DRAFT_UPDATE_FAILED");
    updatedRoom = done;

    await tx
      .update(league)
      .set({ status: "ACTIVE", updatedAt: input.now })
      .where(eq(league.id, lg.id));

    await emitToAllManagers(tx, r.id, lg, "DRAFT_COMPLETE", {
      subject: `The draft for ${lg.name} is complete`,
      body: `All ${r.totalPicks} picks are in. ${lg.name} is now ACTIVE.`,
    });
  } else {
    const deadline = addHours(input.now, r.pickTimerHours);
    const [advanced] = await tx
      .update(draftRoom)
      .set({
        currentPickNumber: nextPick,
        currentPickDeadline: deadline,
        updatedAt: input.now,
      })
      .where(eq(draftRoom.id, r.id))
      .returning();
    if (!advanced) throw new DraftError("draft update failed", "DRAFT_UPDATE_FAILED");
    updatedRoom = advanced;
    await emitOnTheClock(tx, advanced, lg, order, input.now);
  }

  return { draftRoom: updatedRoom, pickNumber, round, autopicked: input.isAutopick };
}

/**
 * Load the autopick for a team. Prefers the team's pre-ranked draft queue (the
 * highest-priority queued player that is still available and a legal roster
 * addition), falling back to the best legal player by `draft_rank` when the
 * queue is empty or yields no legal pick. Snake order / timer are unaffected.
 */
export async function pickAutopickPlayer(
  tx: DbTx,
  draftRoomId: number,
  leagueId: number,
  fantasyTeamId: number,
): Promise<AutopickCandidate> {
  // Current roster composition.
  const slots = await tx
    .select({ position: rosterSlot.draftedPosition })
    .from(rosterSlot)
    .where(eq(rosterSlot.fantasyTeamId, fantasyTeamId));
  const counts = countsFromPositions(slots.map((s) => s.position));

  // Players already taken anywhere in this league.
  const taken = await tx
    .select({ playerId: rosterSlot.playerId })
    .from(rosterSlot)
    .where(eq(rosterSlot.leagueId, leagueId));
  const takenIds = new Set(taken.map((t) => t.playerId));

  const allPlayers = await tx.select().from(player);
  const available: AutopickCandidate[] = allPlayers
    .filter((p) => !takenIds.has(p.id))
    .map((p) => ({
      playerId: p.id,
      fullName: p.fullName,
      position: p.position,
      draftRank: p.draftRank,
    }));

  // The team's queued targets, priority order (rank asc). chooseAutopick uses
  // these first, then falls back to draft_rank.
  const queue = await queuedPlayerIds(tx, draftRoomId, fantasyTeamId);

  const { pick } = chooseAutopick(counts, available, ROSTER_REQUIREMENTS, queue);
  if (!pick) {
    throw new DraftError(
      `autopick found no legal player for team ${fantasyTeamId}`,
      "NO_LEGAL_AUTOPICK",
    );
  }
  return pick;
}

export function resolveOrder(teamIds: number[], explicit: number[] | undefined): number[] {
  if (explicit) {
    if (explicit.length !== teamIds.length) {
      throw new DraftError(
        "explicit order must list every team exactly once",
        "BAD_ORDER",
      );
    }
    const want = new Set(teamIds);
    const seen = new Set<number>();
    for (const id of explicit) {
      if (!want.has(id) || seen.has(id)) {
        throw new DraftError(
          "explicit order must be a permutation of the league's teams",
          "BAD_ORDER",
        );
      }
      seen.add(id);
    }
    return [...explicit];
  }
  // Fisher-Yates shuffle.
  const shuffled = [...teamIds];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = shuffled[i] as number;
    const b = shuffled[j] as number;
    shuffled[i] = b;
    shuffled[j] = a;
  }
  return shuffled;
}

export function addHours(base: Date, hours: number): Date {
  return new Date(base.getTime() + hours * 60 * 60 * 1000);
}

// --- notification emitters (in-transaction) ---------------------------------

interface NotificationContent {
  subject: string;
  body: string;
}

/** Insert a PENDING notification for one manager. */
async function emitNotification(
  tx: DbTx,
  draftRoomId: number,
  managerId: number,
  fantasyTeamId: number | null,
  type: DraftNotificationType,
  content: NotificationContent,
): Promise<void> {
  await tx.insert(draftNotification).values({
    draftRoomId,
    managerId,
    fantasyTeamId,
    type,
    subject: content.subject,
    body: content.body,
  });
}

/** Emit one notification to every manager in the league. */
export async function emitToAllManagers(
  tx: DbTx,
  draftRoomId: number,
  lg: LeagueRow,
  type: DraftNotificationType,
  content: NotificationContent,
): Promise<void> {
  const members = await tx
    .select()
    .from(leagueMembership)
    .where(eq(leagueMembership.leagueId, lg.id));
  for (const m of members) {
    await emitNotification(tx, draftRoomId, m.managerId, null, type, content);
  }
}

/** Emit the load-bearing ON_THE_CLOCK notification for the current pick. */
export async function emitOnTheClock(
  tx: DbTx,
  r: DraftRoomRow,
  lg: LeagueRow,
  order: number[],
  now: Date,
): Promise<void> {
  const onClock = teamOnClock(r, order);
  const [team] = await tx
    .select()
    .from(fantasyTeam)
    .where(eq(fantasyTeam.id, onClock.fantasyTeamId));
  if (!team) return;
  const deadline = r.currentPickDeadline ?? addHours(now, r.pickTimerHours);
  await emitNotification(tx, r.id, team.managerId, team.id, "ON_THE_CLOCK", {
    subject: `You're on the clock in ${lg.name}`,
    body:
      `It's your pick (#${onClock.pickNumber}, round ${onClock.round}) in ${lg.name}. ` +
      `Make your selection before ${deadline.toISOString()} or it will be autopicked.`,
  });
}
