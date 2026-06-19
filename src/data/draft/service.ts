/**
 * Async snake-draft state machine (Phase 4).
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

import { and, asc, eq, inArray } from "drizzle-orm";

import type { Db, DbTx } from "../db/client.js";
import {
  draftNotification,
  draftOrder,
  draftPick,
  draftRoom,
  fantasyTeam,
  league,
  leagueMembership,
  manager,
  player,
  rosterSlot,
  type DraftNotificationType,
  type DraftRoomRow,
  type LeagueRow,
} from "../db/schema.js";
import { DraftError } from "../league/errors.js";
import { allowedChannels } from "../notify/preferences.js";
import { addPlayerToRosterTx } from "../roster/service.js";
import { countsFromPositions, ROSTER_REQUIREMENTS } from "../roster/validator.js";
import { chooseAutopick, type AutopickCandidate } from "./autopick.js";
import { queuedPlayerIds } from "./queue.js";
import type { Notifier } from "./notifier.js";
import { roundForPick, slotForPick } from "./snake.js";

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

// --- internals --------------------------------------------------------------

async function loadRoom(tx: DbTx | Db, draftRoomId: number): Promise<DraftRoomRow> {
  const [r] = await tx.select().from(draftRoom).where(eq(draftRoom.id, draftRoomId));
  if (!r) throw new DraftError(`draft room ${draftRoomId} not found`, "DRAFT_NOT_FOUND");
  return r;
}

/** Round-1 team order: index 0 is slot 1. */
async function loadOrder(tx: DbTx | Db, draftRoomId: number): Promise<number[]> {
  const rows = await tx
    .select()
    .from(draftOrder)
    .where(eq(draftOrder.draftRoomId, draftRoomId))
    .orderBy(asc(draftOrder.slot));
  return rows.map((r) => r.fantasyTeamId);
}

function requireInProgress(r: DraftRoomRow): void {
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
function teamOnClock(r: DraftRoomRow, order: number[]): OnClock {
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
async function applyPick(
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
async function pickAutopickPlayer(
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

function resolveOrder(teamIds: number[], explicit: number[] | undefined): number[] {
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

function addHours(base: Date, hours: number): Date {
  return new Date(base.getTime() + hours * 60 * 60 * 1000);
}

// --- notifications ----------------------------------------------------------

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
async function emitToAllManagers(
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
async function emitOnTheClock(
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

/**
 * Deliver every not-yet-SENT notification (PENDING or a prior FAILED) via
 * the notifier. A no-op when no notifier is supplied - the rows stay
 * durable and a later call delivers them.
 */
export async function deliverPending(
  db: Db,
  notifier: Notifier | undefined,
  draftRoomId?: number,
): Promise<{ delivered: number; failed: number }> {
  if (!notifier) return { delivered: 0, failed: 0 };

  const pending = await db
    .select()
    .from(draftNotification)
    .where(
      draftRoomId !== undefined
        ? and(
            eq(draftNotification.draftRoomId, draftRoomId),
            inArray(draftNotification.status, ["PENDING", "FAILED"]),
          )
        : inArray(draftNotification.status, ["PENDING", "FAILED"]),
    );

  let delivered = 0;
  let failed = 0;
  for (const n of pending) {
    const [mgr] = await db.select().from(manager).where(eq(manager.id, n.managerId));
    if (!mgr) continue;

    // Phase 8 interim: the draft still delivers over this legacy email path
    // (not the Phase 0 hub), so honour the manager's notification preferences
    // here. If they have opted out of EMAIL for this category, mark the row
    // handled so it is not retried each tick, and skip the send.
    const channels = await allowedChannels(db, n.managerId, n.type, ["EMAIL"]);
    if (!channels.includes("EMAIL")) {
      await db
        .update(draftNotification)
        .set({ status: "SENT", sentAt: new Date() })
        .where(eq(draftNotification.id, n.id));
      continue;
    }

    // Enrich with the league id and team name so a rich notifier can build a
    // direct draft-room link. Cheap lookups; the set of pending rows is small.
    const [room] = await db
      .select({ leagueId: draftRoom.leagueId })
      .from(draftRoom)
      .where(eq(draftRoom.id, n.draftRoomId));
    let teamName: string | null = null;
    if (n.fantasyTeamId !== null) {
      const [t] = await db
        .select({ name: fantasyTeam.name })
        .from(fantasyTeam)
        .where(eq(fantasyTeam.id, n.fantasyTeamId));
      teamName = t?.name ?? null;
    }

    const result = await notifier.send({
      to: mgr.email,
      toName: mgr.displayName,
      type: n.type,
      subject: n.subject,
      body: n.body,
      ...(room ? { leagueId: room.leagueId } : {}),
      teamName,
    });
    if (result.delivered) {
      await db
        .update(draftNotification)
        .set({ status: "SENT", sentAt: new Date() })
        .where(eq(draftNotification.id, n.id));
      delivered += 1;
    } else {
      await db
        .update(draftNotification)
        .set({ status: "FAILED" })
        .where(eq(draftNotification.id, n.id));
      failed += 1;
    }
  }
  return { delivered, failed };
}
