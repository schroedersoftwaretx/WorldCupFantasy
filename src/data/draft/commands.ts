/**
 * Async snake-draft state machine - public operations (Phase 4).
 *
 * The draft is NOT a live room - it is notification-driven and may span
 * 5-10 real days. The core loop (section 6.3 of the plan):
 *
 *   notify the on-the-clock manager -> accept their pick whenever it
 *   arrives -> advance -> autopick at timer expiry.
 *
 * Public operations:
 *
 *   createDraftRoom      Create a PENDING draft for a league.
 *   startDraft           Freeze the snake order, put pick 1 on the clock,
 *                        move the league to DRAFTING.
 *   makePick             A manager makes their pick (turn-checked).
 *   processExpiredPicks  Autopick every pick whose 12h timer has lapsed.
 *                        This is what `draft:tick` calls on a schedule.
 *   getDraftState        Read model for "whose turn, when's the deadline".
 *
 * Reliability notes:
 *   - Every pick (manual or auto) and its roster slot and the draft
 *     advance commit in ONE transaction, so the draft can never be left
 *     half-advanced.
 *   - Notifications are written to draft_notification (PENDING) inside that
 *     transaction, then delivered best-effort afterwards. A failed or
 *     deferred delivery is retried on the next tick - the durable row
 *     means a manager is never silently left un-notified.
 */

import { and, eq } from "drizzle-orm";

import type { Db } from "../db/client.js";
import {
  draftOrder,
  draftPick,
  draftRoom,
  fantasyTeam,
  league,
  type DraftRoomRow,
} from "../db/schema.js";
import { DraftError } from "../league/errors.js";
import type { Notifier } from "./notifier.js";
import {
  addHours,
  applyPick,
  emitOnTheClock,
  emitToAllManagers,
  loadOrder,
  loadRoom,
  pickAutopickPlayer,
  requireInProgress,
  resolveOrder,
  teamOnClock,
} from "./internals.js";
import { deliverPending } from "./notifications.js";

// --- createDraftRoom --------------------------------------------------------

export interface CreateDraftRoomInput {
  leagueId: number;
  /** Per-pick timer in hours; 12 per the plan. Shorten for a fast cycle. */
  pickTimerHours?: number;
}

export async function createDraftRoom(
  db: Db,
  input: CreateDraftRoomInput,
): Promise<DraftRoomRow> {
  const [lg] = await db.select().from(league).where(eq(league.id, input.leagueId));
  if (!lg) {
    throw new DraftError(`league ${input.leagueId} does not exist`, "LEAGUE_NOT_FOUND");
  }
  const existing = await db
    .select()
    .from(draftRoom)
    .where(eq(draftRoom.leagueId, input.leagueId));
  if (existing[0]) {
    throw new DraftError("league already has a draft room", "DRAFT_ALREADY_EXISTS");
  }
  const timer = input.pickTimerHours ?? 12;
  if (typeof timer !== "number" || !isFinite(timer) || timer < 0) {
    throw new DraftError("pickTimerHours must be a non-negative number", "INVALID_TIMER");
  }
  const [room] = await db
    .insert(draftRoom)
    .values({ leagueId: input.leagueId, pickTimerHours: timer })
    .returning();
  if (!room) throw new DraftError("draft room insert failed", "DRAFT_INSERT_FAILED");
  return room;
}

// --- startDraft -------------------------------------------------------------

export interface StartDraftInput {
  draftRoomId: number;
  /**
   * Explicit round-1 order as fantasy_team ids. If omitted the order is
   * randomised. Must contain exactly the league's teams, once each.
   */
  order?: number[];
  notifier?: Notifier;
}

export async function startDraft(
  db: Db,
  input: StartDraftInput,
  now: Date = new Date(),
): Promise<DraftRoomRow> {
  const room = await db.transaction(async (tx) => {
    const r = await loadRoom(tx, input.draftRoomId);
    if (r.status !== "PENDING") {
      throw new DraftError(`draft is ${r.status}, cannot start`, "DRAFT_NOT_PENDING");
    }
    const [lg] = await tx.select().from(league).where(eq(league.id, r.leagueId));
    if (!lg) throw new DraftError("league missing", "LEAGUE_NOT_FOUND");

    const teams = await tx
      .select()
      .from(fantasyTeam)
      .where(eq(fantasyTeam.leagueId, r.leagueId));
    if (teams.length < 2) {
      throw new DraftError(
        "a draft needs at least 2 teams",
        "TOO_FEW_TEAMS",
      );
    }

    const order = resolveOrder(
      teams.map((t) => t.id),
      input.order,
    );
    for (let i = 0; i < order.length; i += 1) {
      await tx.insert(draftOrder).values({
        draftRoomId: r.id,
        slot: i + 1,
        fantasyTeamId: order[i] as number,
      });
    }

    const totalPicks = order.length * lg.rosterSize;
    const deadline = addHours(now, r.pickTimerHours);
    const [updated] = await tx
      .update(draftRoom)
      .set({
        status: "IN_PROGRESS",
        totalPicks,
        currentPickNumber: 1,
        currentPickDeadline: deadline,
        startedAt: now,
        updatedAt: now,
      })
      .where(eq(draftRoom.id, r.id))
      .returning();
    if (!updated) throw new DraftError("draft update failed", "DRAFT_UPDATE_FAILED");

    await tx
      .update(league)
      .set({ status: "DRAFTING", updatedAt: now })
      .where(eq(league.id, lg.id));

    // DRAFT_STARTED to everyone, then ON_THE_CLOCK to pick 1's team.
    await emitToAllManagers(tx, r.id, lg, "DRAFT_STARTED", {
      subject: `The draft for ${lg.name} has started`,
      body: `The snake draft for ${lg.name} is underway. ${order.length} managers, ${totalPicks} picks.`,
    });
    await emitOnTheClock(tx, updated, lg, order, now);

    return updated;
  });

  await deliverPending(db, input.notifier, room.id);
  return room;
}

// --- makePick ---------------------------------------------------------------

export interface MakePickInput {
  draftRoomId: number;
  /** The team claiming the pick; must be the one on the clock. */
  fantasyTeamId: number;
  playerId: number;
  notifier?: Notifier;
}

export interface MakePickResult {
  draftRoom: DraftRoomRow;
  pickNumber: number;
  round: number;
  autopicked: boolean;
}

export async function makePick(
  db: Db,
  input: MakePickInput,
  now: Date = new Date(),
): Promise<MakePickResult> {
  const result = await db.transaction(async (tx) => {
    const r = await loadRoom(tx, input.draftRoomId);
    requireInProgress(r);
    const order = await loadOrder(tx, r.id);
    const onClock = teamOnClock(r, order);
    if (input.fantasyTeamId !== onClock.fantasyTeamId) {
      throw new DraftError(
        `team ${input.fantasyTeamId} is not on the clock ` +
          `(pick ${onClock.pickNumber} belongs to team ${onClock.fantasyTeamId})`,
        "NOT_ON_THE_CLOCK",
      );
    }
    return applyPick(tx, r, order, {
      fantasyTeamId: input.fantasyTeamId,
      playerId: input.playerId,
      isAutopick: false,
      now,
    });
  });

  await deliverPending(db, input.notifier, input.draftRoomId);
  return result;
}

// --- processExpiredPicks ----------------------------------------------------

export interface ProcessExpiredInput {
  /** Limit to one draft room; otherwise every IN_PROGRESS draft. */
  draftRoomId?: number;
  notifier?: Notifier;
}

export interface ProcessExpiredResult {
  /** Number of autopicks made across all processed drafts. */
  autopicks: number;
  /** Draft rooms that had at least one expired pick processed. */
  draftsTouched: number;
}

/**
 * Autopick every pick whose deadline has lapsed. Idempotent: with nothing
 * expired it is a no-op. Each autopick is its own transaction, so a long
 * dormant draft is caught up safely one pick at a time. (With a non-zero
 * timer, each autopick sets a fresh deadline in the future, so a tick
 * normally makes exactly one autopick per draft and the next manager gets
 * a full window; a zero timer drains the whole draft in one tick.)
 */
export async function processExpiredPicks(
  db: Db,
  input: ProcessExpiredInput = {},
  now: Date = new Date(),
): Promise<ProcessExpiredResult> {
  const rooms = await db
    .select()
    .from(draftRoom)
    .where(
      input.draftRoomId !== undefined
        ? and(
            eq(draftRoom.id, input.draftRoomId),
            eq(draftRoom.status, "IN_PROGRESS"),
          )
        : eq(draftRoom.status, "IN_PROGRESS"),
    );

  let autopicks = 0;
  let draftsTouched = 0;

  for (const room of rooms) {
    let touched = false;
    // Safety bound: never loop more than the draft's total picks.
    for (let guard = 0; guard <= room.totalPicks; guard += 1) {
      const made = await db.transaction(async (tx) => {
        const r = await loadRoom(tx, room.id);
        if (r.status !== "IN_PROGRESS") return false;
        if (r.currentPickDeadline === null || r.currentPickDeadline.getTime() > now.getTime()) {
          return false;
        }
        const order = await loadOrder(tx, r.id);
        const onClock = teamOnClock(r, order);
        const pick = await pickAutopickPlayer(tx, r.id, r.leagueId, onClock.fantasyTeamId);
        await applyPick(tx, r, order, {
          fantasyTeamId: onClock.fantasyTeamId,
          playerId: pick.playerId,
          isAutopick: true,
          now,
        });
        return true;
      });
      if (!made) break;
      autopicks += 1;
      touched = true;
    }
    if (touched) draftsTouched += 1;
  }

  await deliverPending(db, input.notifier, input.draftRoomId);
  return { autopicks, draftsTouched };
}

// --- forceCurrentAutopick --------------------------------------------------

export interface ForceAutopickResult {
  /** The player that was autopicked, or null if the draft is not in progress. */
  pick: { playerId: number; fullName: string; position: string } | null;
}

/**
 * Immediately autopick for the team currently on the clock, bypassing the
 * timer deadline. Used by the league owner to skip a pick without waiting.
 * Has no effect when the draft is not IN_PROGRESS.
 */
export async function forceCurrentAutopick(
  db: Db,
  draftRoomId: number,
  now: Date = new Date(),
  notifier?: Notifier,
): Promise<ForceAutopickResult> {
  const result = await db.transaction(async (tx) => {
    const r = await loadRoom(tx, draftRoomId);
    if (r.status !== "IN_PROGRESS") return null;
    const order = await loadOrder(tx, r.id);
    const onClock = teamOnClock(r, order);
    const pick = await pickAutopickPlayer(tx, r.id, r.leagueId, onClock.fantasyTeamId);
    await applyPick(tx, r, order, {
      fantasyTeamId: onClock.fantasyTeamId,
      playerId: pick.playerId,
      isAutopick: true,
      now,
    });
    return pick;
  });

  await deliverPending(db, notifier, draftRoomId);
  return { pick: result };
}

// --- getDraftState ----------------------------------------------------------

export interface DraftStateView {
  draftRoom: DraftRoomRow;
  managerCount: number;
  picksMade: number;
  onClock: {
    pickNumber: number;
    round: number;
    slot: number;
    fantasyTeamId: number;
  } | null;
}

export async function getDraftState(
  db: Db,
  draftRoomId: number,
): Promise<DraftStateView> {
  const r = await loadRoom(db, draftRoomId);
  const order = await loadOrder(db, r.id);
  const picks = await db
    .select({ id: draftPick.id })
    .from(draftPick)
    .where(eq(draftPick.draftRoomId, r.id));
  const onClock =
    r.status === "IN_PROGRESS" && r.currentPickNumber !== null && order.length > 0
      ? (() => {
          const oc = teamOnClock(r, order);
          return {
            pickNumber: oc.pickNumber,
            round: oc.round,
            slot: oc.slot,
            fantasyTeamId: oc.fantasyTeamId,
          };
        })()
      : null;
  return {
    draftRoom: r,
    managerCount: order.length,
    picksMade: picks.length,
    onClock,
  };
}
