/**
 * In-season transactions service (Priority 5): free agency, waivers, trades.
 * Gated by the `transactions` feature flag; a league without the flag never
 * reaches any write here (and standings never load the ledger).
 *
 * MODEL (ESPN/Yahoo style, adapted to exclusive-ownership rosters):
 *   - FREE AGENT add/drop: any player rostered by nobody in the league may be
 *     added instantly - unless he is ON WAIVERS (recently dropped). Dropping
 *     a player puts him on waivers for `waiverHours` (flag config, default
 *     24h).
 *   - WAIVER CLAIMS: a player on waivers can only be claimed. When his window
 *     expires the cron awards him to the claiming team worst-placed in the
 *     CURRENT standings (reverse-standings priority, ties by claim time).
 *   - TRADES: propose / accept / reject / cancel, plus commissioner VETO of a
 *     pending proposal. Executed atomically at accept time.
 *
 * Every executed movement appends roster_transaction ledger rows stamped with
 * the first not-yet-started period's ordinal, so scoring can reconstruct the
 * roster each period actually had (see effective-roster.ts).
 *
 * Roster legality: after any movement a roster must stay within the league's
 * roster size and either be a legal complete roster (when full) or still be
 * completable (when short) - the same validator the draft uses, so best-ball
 * optimizer guarantees (>=2 GK etc. at full size) keep holding.
 *
 * Pure service: takes a Db and plain inputs; no HTTP/auth/env here.
 */
import { and, asc, eq, inArray, lte } from "drizzle-orm";

import type { Db, DbTx } from "../db/client.js";
import {
  fantasyTeam,
  fixture,
  league,
  leagueMembership,
  player,
  playerWaiver,
  rosterSlot,
  rosterTransaction,
  trade,
  tradeItem,
  waiverClaim,
  type LeagueRow,
  type Position,
  type RosterTransactionRow,
  type TradeItemRow,
  type TradeRow,
  type WaiverClaimRow,
} from "../db/schema.js";
import {
  assignFixturesToPeriods,
  getScoringPeriods,
} from "../competition/periods.js";
import { getFlagStates } from "../league/feature-flags.js";
import {
  ROSTER_REQUIREMENTS,
  countsFromPositions,
  isRosterCompletable,
  validateCompleteRoster,
  type RosterRequirements,
} from "../roster/validator.js";
import { enqueue } from "../notify/service.js";
import { recordEvent } from "../social/activity.js";
import { computeStandings } from "../standings/standings.js";
import { TransactionError } from "./errors.js";

export type TransactionKind = "ADD" | "DROP" | "TRADE";
export type WaiverStatus =
  | "PENDING"
  | "AWARDED"
  | "LOST"
  | "INVALID"
  | "CANCELLED";
export type TradeStatus =
  | "PROPOSED"
  | "ACCEPTED"
  | "REJECTED"
  | "CANCELLED"
  | "VETOED";

const DEFAULT_WAIVER_HOURS = 24;
const MS_PER_HOUR = 3_600_000;

// --- gate ---------------------------------------------------------------------

interface TransactionsContext {
  lg: LeagueRow;
  role: "OWNER" | "MEMBER";
  waiverHours: number;
}

/** Flag + membership + league-status gate shared by every entry point. */
async function requireTransactions(
  db: Db | DbTx,
  leagueId: number,
  managerId: number,
): Promise<TransactionsContext> {
  const [lg] = await db.select().from(league).where(eq(league.id, leagueId));
  if (!lg) {
    throw new TransactionError(
      `league ${leagueId} does not exist`,
      "LEAGUE_NOT_FOUND",
    );
  }
  const flags = await getFlagStates(db, leagueId);
  if (!flags.transactions.enabled) {
    throw new TransactionError(
      `league ${leagueId} does not have the transactions flag enabled`,
      "TRANSACTIONS_FLAG_DISABLED",
    );
  }
  if (lg.status !== "ACTIVE") {
    throw new TransactionError(
      `transactions are only available while a league is ACTIVE (status: ${lg.status})`,
      "LEAGUE_NOT_ACTIVE",
    );
  }
  const [membership] = await db
    .select()
    .from(leagueMembership)
    .where(
      and(
        eq(leagueMembership.leagueId, leagueId),
        eq(leagueMembership.managerId, managerId),
      ),
    );
  if (!membership) {
    throw new TransactionError(
      `manager ${managerId} is not a member of league ${leagueId}`,
      "NOT_A_MEMBER",
    );
  }
  const config = flags.transactions.config as { waiverHours?: number } | null;
  const waiverHours =
    config &&
    Number.isFinite(config.waiverHours) &&
    (config.waiverHours as number) >= 0
      ? Math.min(config.waiverHours as number, 168)
      : DEFAULT_WAIVER_HOURS;
  return { lg, role: membership.role, waiverHours };
}

/** The manager's fantasy_team in a league (every member has exactly one). */
async function teamOf(
  db: Db | DbTx,
  leagueId: number,
  managerId: number,
): Promise<{ id: number; name: string }> {
  const [team] = await db
    .select({ id: fantasyTeam.id, name: fantasyTeam.name })
    .from(fantasyTeam)
    .where(
      and(
        eq(fantasyTeam.leagueId, leagueId),
        eq(fantasyTeam.managerId, managerId),
      ),
    );
  if (!team) {
    throw new TransactionError(
      `manager ${managerId} has no team in league ${leagueId}`,
      "TEAM_NOT_FOUND",
    );
  }
  return team;
}

// --- effectivity ----------------------------------------------------------------

/**
 * The ordinal of the first scoring period whose first kickoff is after `now`
 * (a period with no fixtures yet counts as future). A movement executed now
 * starts scoring in that period. When every period has started, returns
 * lastOrdinal + 1 - the movement affects no period, which is correct.
 */
export async function effectiveOrdinalAt(
  db: Db | DbTx,
  lg: LeagueRow,
  now: Date,
): Promise<number> {
  const periods = await getScoringPeriods(db, lg.competitionId);
  const fixtures = await db.select().from(fixture);
  const byFixture = assignFixturesToPeriods(periods, fixtures);
  const firstByOrdinal = new Map<number, Date>();
  for (const f of fixtures) {
    const ord = byFixture.get(f.id);
    if (ord === undefined) continue;
    const cur = firstByOrdinal.get(ord);
    if (!cur || f.kickoffUtc < cur) firstByOrdinal.set(ord, f.kickoffUtc);
  }
  let best: number | null = null;
  let last = 0;
  for (const p of periods) {
    last = Math.max(last, p.ordinal);
    const first = firstByOrdinal.get(p.ordinal);
    const isFuture = first === undefined || first > now;
    if (isFuture && (best === null || p.ordinal < best)) best = p.ordinal;
  }
  return best ?? last + 1;
}

// --- roster legality -------------------------------------------------------------

interface RosterPlayerRef {
  playerId: number;
  position: Position;
}

/**
 * Validate the roster that results from removing `drops` and adding `adds`.
 * A full roster must stay a legal complete roster; a short one must stay
 * completable and never exceed the league's roster size.
 */
function validateResultingRoster(
  current: readonly RosterPlayerRef[],
  adds: readonly RosterPlayerRef[],
  drops: readonly number[],
  rosterSize: number,
): void {
  const dropSet = new Set(drops);
  const next = current.filter((p) => !dropSet.has(p.playerId)).concat(adds);
  if (next.length > rosterSize) {
    throw new TransactionError(
      `move would leave ${next.length} players; roster size is ${rosterSize} (drop someone)`,
      "ROSTER_FULL",
    );
  }
  const reqs: RosterRequirements = { ...ROSTER_REQUIREMENTS, rosterSize };
  const counts = countsFromPositions(next.map((p) => p.position));
  if (next.length === rosterSize) {
    const result = validateCompleteRoster(counts, reqs);
    if (!result.ok) {
      throw new TransactionError(
        `move would break roster rules: ${result.errors.join("; ")}`,
        "ROSTER_ILLEGAL",
      );
    }
  } else if (!isRosterCompletable(counts, reqs)) {
    throw new TransactionError(
      "move would leave a roster that cannot be completed into a legal squad",
      "ROSTER_ILLEGAL",
    );
  }
}

/** Current roster of a team with player positions. */
async function currentRoster(
  db: Db | DbTx,
  fantasyTeamId: number,
): Promise<RosterPlayerRef[]> {
  const rows = await db
    .select({ playerId: rosterSlot.playerId, position: player.position })
    .from(rosterSlot)
    .innerJoin(player, eq(player.id, rosterSlot.playerId))
    .where(eq(rosterSlot.fantasyTeamId, fantasyTeamId));
  return rows;
}

// --- free-agent add/drop -----------------------------------------------------------

export interface AddDropInput {
  leagueId: number;
  managerId: number;
  /** Free agent to add (optional when only dropping). */
  addPlayerId?: number;
  /** Rostered player to release (optional when roster has room). */
  dropPlayerId?: number;
  /** Injectable clock for tests. */
  now?: Date;
}

export interface AddDropResult {
  added: number | null;
  dropped: number | null;
  effectiveOrdinal: number;
}

/**
 * Shared executor for a validated {add?, drop?} movement on one team.
 * Caller has already verified ownership of the drop and freedom/waiver
 * state of the add. Mutates roster_slot, maintains player_waiver, appends
 * ledger rows. Runs inside the caller's transaction.
 */
async function executeAddDropTx(
  tx: DbTx,
  args: {
    leagueId: number;
    fantasyTeamId: number;
    add: RosterPlayerRef | null;
    dropPlayerId: number | null;
    effectiveOrdinal: number;
    now: Date;
    waiverHours: number;
    waiverClaimId?: number;
  },
): Promise<void> {
  const {
    leagueId,
    fantasyTeamId,
    add,
    dropPlayerId,
    effectiveOrdinal,
    now,
    waiverHours,
  } = args;
  if (dropPlayerId !== null) {
    await tx
      .delete(rosterSlot)
      .where(
        and(
          eq(rosterSlot.fantasyTeamId, fantasyTeamId),
          eq(rosterSlot.playerId, dropPlayerId),
        ),
      );
    // The dropped player goes on waivers.
    const until = new Date(now.getTime() + waiverHours * MS_PER_HOUR);
    await tx
      .insert(playerWaiver)
      .values({ leagueId, playerId: dropPlayerId, untilUtc: until, createdAt: now })
      .onConflictDoUpdate({
        target: [playerWaiver.leagueId, playerWaiver.playerId],
        set: { untilUtc: until, createdAt: now },
      });
    await tx.insert(rosterTransaction).values({
      leagueId,
      kind: "DROP",
      playerId: dropPlayerId,
      fromFantasyTeamId: fantasyTeamId,
      toFantasyTeamId: null,
      effectiveOrdinal,
      waiverClaimId: args.waiverClaimId ?? null,
      createdAt: now,
    });
  }
  if (add !== null) {
    await tx.insert(rosterSlot).values({
      fantasyTeamId,
      playerId: add.playerId,
      leagueId,
      draftedPosition: add.position,
      draftedAt: now,
    });
    await tx.insert(rosterTransaction).values({
      leagueId,
      kind: "ADD",
      playerId: add.playerId,
      fromFantasyTeamId: null,
      toFantasyTeamId: fantasyTeamId,
      effectiveOrdinal,
      waiverClaimId: args.waiverClaimId ?? null,
      createdAt: now,
    });
  }
}

/** Common validation for an {add?, drop?} pair on a team. Returns the add's
 * position ref (null when not adding). */
async function validateAddDrop(
  db: Db | DbTx,
  args: {
    leagueId: number;
    fantasyTeamId: number;
    addPlayerId: number | null;
    dropPlayerId: number | null;
    rosterSize: number;
    /** When true, an active waiver window on the add blocks the move. */
    respectWaivers: boolean;
    now: Date;
  },
): Promise<RosterPlayerRef | null> {
  const { leagueId, fantasyTeamId, addPlayerId, dropPlayerId, now } = args;
  if (addPlayerId === null && dropPlayerId === null) {
    throw new TransactionError(
      "nothing to do: provide addPlayerId and/or dropPlayerId",
      "EMPTY_MOVE",
    );
  }
  const roster = await currentRoster(db, fantasyTeamId);
  if (dropPlayerId !== null && !roster.some((p) => p.playerId === dropPlayerId)) {
    throw new TransactionError(
      `player ${dropPlayerId} is not on your roster`,
      "DROP_NOT_ON_ROSTER",
    );
  }
  let add: RosterPlayerRef | null = null;
  if (addPlayerId !== null) {
    const [target] = await db
      .select({ id: player.id, position: player.position })
      .from(player)
      .where(eq(player.id, addPlayerId));
    if (!target) {
      throw new TransactionError(
        `player ${addPlayerId} does not exist`,
        "PLAYER_NOT_FOUND",
      );
    }
    const [taken] = await db
      .select({ playerId: rosterSlot.playerId })
      .from(rosterSlot)
      .where(
        and(
          eq(rosterSlot.leagueId, leagueId),
          eq(rosterSlot.playerId, addPlayerId),
        ),
      );
    if (taken) {
      throw new TransactionError(
        `player ${addPlayerId} is already rostered in this league`,
        "PLAYER_TAKEN",
      );
    }
    if (args.respectWaivers) {
      const [wv] = await db
        .select()
        .from(playerWaiver)
        .where(
          and(
            eq(playerWaiver.leagueId, leagueId),
            eq(playerWaiver.playerId, addPlayerId),
          ),
        );
      if (wv && wv.untilUtc > now) {
        throw new TransactionError(
          `player ${addPlayerId} is on waivers until ${wv.untilUtc.toISOString()} - submit a claim instead`,
          "PLAYER_ON_WAIVERS",
        );
      }
    }
    add = { playerId: target.id, position: target.position };
  }
  validateResultingRoster(
    roster,
    add ? [add] : [],
    dropPlayerId !== null ? [dropPlayerId] : [],
    args.rosterSize,
  );
  return add;
}

/**
 * Execute a direct free-agent add and/or drop for the caller's team.
 * Instant - no waiver window applies to the ADD (it must not be on waivers).
 */
export async function addDropPlayers(
  db: Db,
  input: AddDropInput,
): Promise<AddDropResult> {
  const now = input.now ?? new Date();
  const { lg, waiverHours } = await requireTransactions(
    db,
    input.leagueId,
    input.managerId,
  );
  const team = await teamOf(db, input.leagueId, input.managerId);
  const effectiveOrdinal = await effectiveOrdinalAt(db, lg, now);

  await db.transaction(async (tx) => {
    const add = await validateAddDrop(tx, {
      leagueId: input.leagueId,
      fantasyTeamId: team.id,
      addPlayerId: input.addPlayerId ?? null,
      dropPlayerId: input.dropPlayerId ?? null,
      rosterSize: lg.rosterSize,
      respectWaivers: true,
      now,
    });
    await executeAddDropTx(tx, {
      leagueId: input.leagueId,
      fantasyTeamId: team.id,
      add,
      dropPlayerId: input.dropPlayerId ?? null,
      effectiveOrdinal,
      now,
      waiverHours,
    });
  });

  await recordEvent(db, input.leagueId, "FA_ADD_DROP", {
    fantasyTeamId: team.id,
    teamName: team.name,
    addPlayerId: input.addPlayerId ?? null,
    dropPlayerId: input.dropPlayerId ?? null,
    effectiveOrdinal,
  });
  return {
    added: input.addPlayerId ?? null,
    dropped: input.dropPlayerId ?? null,
    effectiveOrdinal,
  };
}

// --- waiver claims -----------------------------------------------------------------

export interface SubmitClaimInput {
  leagueId: number;
  managerId: number;
  addPlayerId: number;
  dropPlayerId?: number;
  now?: Date;
}

/** Submit a claim for a player currently on waivers. */
export async function submitWaiverClaim(
  db: Db,
  input: SubmitClaimInput,
): Promise<WaiverClaimRow> {
  const now = input.now ?? new Date();
  const { lg } = await requireTransactions(db, input.leagueId, input.managerId);
  const team = await teamOf(db, input.leagueId, input.managerId);

  const [wv] = await db
    .select()
    .from(playerWaiver)
    .where(
      and(
        eq(playerWaiver.leagueId, input.leagueId),
        eq(playerWaiver.playerId, input.addPlayerId),
      ),
    );
  if (!wv || wv.untilUtc <= now) {
    throw new TransactionError(
      `player ${input.addPlayerId} is not on waivers - add him directly`,
      "NOT_ON_WAIVERS",
    );
  }
  // Soft-validate now for immediate feedback; re-validated at award time.
  await validateAddDrop(db, {
    leagueId: input.leagueId,
    fantasyTeamId: team.id,
    addPlayerId: input.addPlayerId,
    dropPlayerId: input.dropPlayerId ?? null,
    rosterSize: lg.rosterSize,
    respectWaivers: false,
    now,
  });
  const [existing] = await db
    .select()
    .from(waiverClaim)
    .where(
      and(
        eq(waiverClaim.fantasyTeamId, team.id),
        eq(waiverClaim.addPlayerId, input.addPlayerId),
        eq(waiverClaim.status, "PENDING"),
      ),
    );
  if (existing) {
    throw new TransactionError(
      `you already have a pending claim for player ${input.addPlayerId}`,
      "DUPLICATE_CLAIM",
    );
  }
  const [row] = await db
    .insert(waiverClaim)
    .values({
      leagueId: input.leagueId,
      fantasyTeamId: team.id,
      addPlayerId: input.addPlayerId,
      dropPlayerId: input.dropPlayerId ?? null,
      status: "PENDING",
      processAfter: wv.untilUtc,
      createdAt: now,
    })
    .returning();
  if (!row) {
    throw new TransactionError("claim insert failed", "CLAIM_INSERT_FAILED");
  }
  return row;
}

/** Cancel one of your own pending claims. */
export async function cancelWaiverClaim(
  db: Db,
  input: { leagueId: number; managerId: number; claimId: number; now?: Date },
): Promise<WaiverClaimRow> {
  const now = input.now ?? new Date();
  await requireTransactions(db, input.leagueId, input.managerId);
  const team = await teamOf(db, input.leagueId, input.managerId);
  const [claim] = await db
    .select()
    .from(waiverClaim)
    .where(eq(waiverClaim.id, input.claimId));
  if (!claim || claim.leagueId !== input.leagueId) {
    throw new TransactionError(
      `claim ${input.claimId} not found`,
      "CLAIM_NOT_FOUND",
    );
  }
  if (claim.fantasyTeamId !== team.id) {
    throw new TransactionError("that claim is not yours", "NOT_YOUR_CLAIM");
  }
  if (claim.status !== "PENDING") {
    throw new TransactionError(
      `claim is already ${claim.status}`,
      "CLAIM_NOT_PENDING",
    );
  }
  const [row] = await db
    .update(waiverClaim)
    .set({ status: "CANCELLED", resolvedAt: now })
    .where(and(eq(waiverClaim.id, claim.id), eq(waiverClaim.status, "PENDING")))
    .returning();
  return row ?? { ...claim, status: "CANCELLED" };
}

export interface WaiverRunSummary {
  leaguesProcessed: number;
  awarded: number;
  lost: number;
  invalid: number;
}

/**
 * Cron entry point: process every claim whose window has expired, league by
 * league. Priority is REVERSE CURRENT STANDINGS (worst team first; ties by
 * claim creation time). Idempotent - claims leave PENDING exactly once, and
 * a rerun sees no PENDING due claims.
 */
export async function processDueWaivers(
  db: Db,
  now: Date = new Date(),
): Promise<WaiverRunSummary> {
  const due = await db
    .select()
    .from(waiverClaim)
    .where(
      and(eq(waiverClaim.status, "PENDING"), lte(waiverClaim.processAfter, now)),
    )
    .orderBy(asc(waiverClaim.id));
  const summary: WaiverRunSummary = {
    leaguesProcessed: 0,
    awarded: 0,
    lost: 0,
    invalid: 0,
  };
  if (due.length === 0) return summary;

  const byLeague = new Map<number, WaiverClaimRow[]>();
  for (const c of due) {
    const list = byLeague.get(c.leagueId) ?? [];
    list.push(c);
    byLeague.set(c.leagueId, list);
  }

  for (const [leagueId, claims] of byLeague) {
    const [lg] = await db.select().from(league).where(eq(league.id, leagueId));
    if (!lg) continue;
    const flags = await getFlagStates(db, leagueId);
    if (!flags.transactions.enabled) continue;
    summary.leaguesProcessed += 1;

    // Reverse-standings priority: worst rank -> first pick of the pool.
    const standings = await computeStandings(db, leagueId);
    const rankByTeam = new Map(standings.map((s) => [s.fantasyTeamId, s.rank]));
    const priority = (c: WaiverClaimRow): number =>
      -(rankByTeam.get(c.fantasyTeamId) ?? 0);

    const effectiveOrdinal = await effectiveOrdinalAt(db, lg, now);
    const config = flags.transactions.config as { waiverHours?: number } | null;
    const waiverHours =
      config &&
      Number.isFinite(config.waiverHours) &&
      (config.waiverHours as number) >= 0
        ? Math.min(config.waiverHours as number, 168)
        : DEFAULT_WAIVER_HOURS;

    // Group due claims by target player; award each group independently.
    const byPlayer = new Map<number, WaiverClaimRow[]>();
    for (const c of claims) {
      const list = byPlayer.get(c.addPlayerId) ?? [];
      list.push(c);
      byPlayer.set(c.addPlayerId, list);
    }

    for (const [, group] of byPlayer) {
      group.sort((a, b) => {
        const p = priority(a) - priority(b);
        if (p !== 0) return p;
        return a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id;
      });
      let winner: WaiverClaimRow | null = null;
      for (const claim of group) {
        if (winner) {
          await db
            .update(waiverClaim)
            .set({
              status: "LOST",
              resolvedAt: now,
              note: `lost to team ${winner.fantasyTeamId}`,
            })
            .where(eq(waiverClaim.id, claim.id));
          summary.lost += 1;
          continue;
        }
        try {
          await db.transaction(async (tx) => {
            const add = await validateAddDrop(tx, {
              leagueId,
              fantasyTeamId: claim.fantasyTeamId,
              addPlayerId: claim.addPlayerId,
              dropPlayerId: claim.dropPlayerId,
              rosterSize: lg.rosterSize,
              respectWaivers: false,
              now,
            });
            await executeAddDropTx(tx, {
              leagueId,
              fantasyTeamId: claim.fantasyTeamId,
              add,
              dropPlayerId: claim.dropPlayerId,
              effectiveOrdinal,
              now,
              waiverHours,
              waiverClaimId: claim.id,
            });
            await tx
              .update(waiverClaim)
              .set({ status: "AWARDED", resolvedAt: now })
              .where(eq(waiverClaim.id, claim.id));
          });
          winner = claim;
          summary.awarded += 1;
          await recordEvent(db, leagueId, "WAIVER_AWARDED", {
            claimId: claim.id,
            fantasyTeamId: claim.fantasyTeamId,
            addPlayerId: claim.addPlayerId,
            dropPlayerId: claim.dropPlayerId,
            effectiveOrdinal,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await db
            .update(waiverClaim)
            .set({ status: "INVALID", resolvedAt: now, note: msg })
            .where(eq(waiverClaim.id, claim.id));
          summary.invalid += 1;
        }
      }
      // Notify every claimant of the outcome.
      for (const claim of group) {
        const [team] = await db
          .select({ managerId: fantasyTeam.managerId })
          .from(fantasyTeam)
          .where(eq(fantasyTeam.id, claim.fantasyTeamId));
        if (!team) continue;
        const won = winner !== null && claim.id === winner.id;
        await enqueue(db, {
          managerId: team.managerId,
          type: "WAIVER_RESULT",
          title: won ? "Waiver claim awarded" : "Waiver claim not awarded",
          body: won
            ? `Your waiver claim was awarded - player ${claim.addPlayerId} is on your roster.`
            : `Your waiver claim for player ${claim.addPlayerId} was not awarded.`,
          leagueId,
          link: `/leagues/${leagueId}/transactions`,
          dedupeKey: `waiver-result:${claim.id}`,
        });
      }
    }
  }
  return summary;
}

// --- trades ---------------------------------------------------------------------

export interface ProposeTradeInput {
  leagueId: number;
  managerId: number;
  counterpartyTeamId: number;
  /** Players leaving the proposer's roster. */
  offerPlayerIds: number[];
  /** Players leaving the counterparty's roster. */
  requestPlayerIds: number[];
  now?: Date;
}

export interface TradeWithItems {
  trade: TradeRow;
  items: TradeItemRow[];
}

/** Propose a trade. Both sides must offer at least one player they own. */
export async function proposeTrade(
  db: Db,
  input: ProposeTradeInput,
): Promise<TradeWithItems> {
  const now = input.now ?? new Date();
  await requireTransactions(db, input.leagueId, input.managerId);
  const myTeam = await teamOf(db, input.leagueId, input.managerId);
  if (input.counterpartyTeamId === myTeam.id) {
    throw new TransactionError("you cannot trade with yourself", "SELF_TRADE");
  }
  const [other] = await db
    .select()
    .from(fantasyTeam)
    .where(
      and(
        eq(fantasyTeam.id, input.counterpartyTeamId),
        eq(fantasyTeam.leagueId, input.leagueId),
      ),
    );
  if (!other) {
    throw new TransactionError(
      `team ${input.counterpartyTeamId} is not in this league`,
      "TEAM_NOT_FOUND",
    );
  }
  const offer = [...new Set(input.offerPlayerIds)];
  const request = [...new Set(input.requestPlayerIds)];
  if (offer.length === 0 || request.length === 0) {
    throw new TransactionError(
      "a trade needs at least one player on each side",
      "EMPTY_TRADE_SIDE",
    );
  }
  const mine = await currentRoster(db, myTeam.id);
  const theirs = await currentRoster(db, other.id);
  const mineIds = new Set(mine.map((p) => p.playerId));
  const theirIds = new Set(theirs.map((p) => p.playerId));
  for (const pid of offer) {
    if (!mineIds.has(pid)) {
      throw new TransactionError(
        `player ${pid} is not on your roster`,
        "OFFER_NOT_ON_ROSTER",
      );
    }
  }
  for (const pid of request) {
    if (!theirIds.has(pid)) {
      throw new TransactionError(
        `player ${pid} is not on the other team's roster`,
        "REQUEST_NOT_ON_ROSTER",
      );
    }
  }

  const result = await db.transaction(async (tx) => {
    const [t] = await tx
      .insert(trade)
      .values({
        leagueId: input.leagueId,
        proposerTeamId: myTeam.id,
        counterpartyTeamId: other.id,
        status: "PROPOSED",
        createdAt: now,
      })
      .returning();
    if (!t) throw new TransactionError("trade insert failed", "TRADE_INSERT_FAILED");
    const values = [
      ...offer.map((pid) => ({
        tradeId: t.id,
        playerId: pid,
        fromTeamId: myTeam.id,
        toTeamId: other.id,
      })),
      ...request.map((pid) => ({
        tradeId: t.id,
        playerId: pid,
        fromTeamId: other.id,
        toTeamId: myTeam.id,
      })),
    ];
    const items = await tx.insert(tradeItem).values(values).returning();
    return { trade: t, items };
  });

  await enqueue(db, {
    managerId: other.managerId,
    type: "TRADE_OFFER",
    title: "New trade offer",
    body: `${myTeam.name} proposed a trade (${offer.length} for ${request.length}).`,
    leagueId: input.leagueId,
    link: `/leagues/${input.leagueId}/transactions`,
    dedupeKey: `trade-offer:${result.trade.id}`,
  });
  return result;
}

export type TradeAction = "ACCEPT" | "REJECT" | "CANCEL" | "VETO";

export interface RespondTradeInput {
  leagueId: number;
  managerId: number;
  tradeId: number;
  action: TradeAction;
  now?: Date;
}

/**
 * Act on a PROPOSED trade. ACCEPT/REJECT by the counterparty owner, CANCEL by
 * the proposer owner, VETO by a league OWNER (commissioner). ACCEPT executes
 * the swap atomically: every item is re-verified against current rosters and
 * both resulting rosters must stay legal.
 */
export async function respondTrade(
  db: Db,
  input: RespondTradeInput,
): Promise<TradeWithItems> {
  const now = input.now ?? new Date();
  const { lg, role } = await requireTransactions(
    db,
    input.leagueId,
    input.managerId,
  );
  const myTeam = await teamOf(db, input.leagueId, input.managerId);
  const [t] = await db.select().from(trade).where(eq(trade.id, input.tradeId));
  if (!t || t.leagueId !== input.leagueId) {
    throw new TransactionError(`trade ${input.tradeId} not found`, "TRADE_NOT_FOUND");
  }
  if (t.status !== "PROPOSED") {
    throw new TransactionError(
      `trade is already ${t.status}`,
      "TRADE_NOT_PROPOSED",
    );
  }
  const items = await db
    .select()
    .from(tradeItem)
    .where(eq(tradeItem.tradeId, t.id));

  const isProposer = t.proposerTeamId === myTeam.id;
  const isCounterparty = t.counterpartyTeamId === myTeam.id;
  const allowed =
    (input.action === "CANCEL" && isProposer) ||
    ((input.action === "ACCEPT" || input.action === "REJECT") && isCounterparty) ||
    (input.action === "VETO" && role === "OWNER");
  if (!allowed) {
    throw new TransactionError(
      `you may not ${input.action} this trade`,
      "TRADE_ACTION_FORBIDDEN",
    );
  }

  if (input.action !== "ACCEPT") {
    const status: TradeStatus =
      input.action === "REJECT"
        ? "REJECTED"
        : input.action === "CANCEL"
          ? "CANCELLED"
          : "VETOED";
    const [updated] = await db
      .update(trade)
      .set({ status, resolvedAt: now })
      .where(and(eq(trade.id, t.id), eq(trade.status, "PROPOSED")))
      .returning();
    const finalTrade = updated ?? { ...t, status };
    // Tell the proposer what happened (unless they cancelled themselves).
    if (input.action !== "CANCEL") {
      const [proposer] = await db
        .select({ managerId: fantasyTeam.managerId })
        .from(fantasyTeam)
        .where(eq(fantasyTeam.id, t.proposerTeamId));
      if (proposer) {
        await enqueue(db, {
          managerId: proposer.managerId,
          type: "TRADE_RESULT",
          title: `Trade ${status.toLowerCase()}`,
          body: `Your trade offer was ${status.toLowerCase()}.`,
          leagueId: input.leagueId,
          link: `/leagues/${input.leagueId}/transactions`,
          dedupeKey: `trade-result:${t.id}`,
        });
      }
    }
    return { trade: finalTrade, items };
  }

  // ACCEPT: execute atomically.
  const effectiveOrdinal = await effectiveOrdinalAt(db, lg, now);
  const executed = await db.transaction(async (tx) => {
    const proposerRoster = await currentRoster(tx, t.proposerTeamId);
    const counterRoster = await currentRoster(tx, t.counterpartyTeamId);
    const posById = new Map<number, Position>();
    for (const p of [...proposerRoster, ...counterRoster]) {
      posById.set(p.playerId, p.position);
    }
    const fromProposer = items.filter((i) => i.fromTeamId === t.proposerTeamId);
    const fromCounter = items.filter(
      (i) => i.fromTeamId === t.counterpartyTeamId,
    );
    const stillOwns = (
      roster: RosterPlayerRef[],
      list: TradeItemRow[],
    ): boolean => {
      const ids = new Set(roster.map((p) => p.playerId));
      return list.every((i) => ids.has(i.playerId));
    };
    if (
      !stillOwns(proposerRoster, fromProposer) ||
      !stillOwns(counterRoster, fromCounter)
    ) {
      throw new TransactionError(
        "a player in this trade has changed teams since it was proposed",
        "TRADE_STALE",
      );
    }
    const ref = (i: TradeItemRow): RosterPlayerRef => ({
      playerId: i.playerId,
      position: posById.get(i.playerId) ?? "MID",
    });
    validateResultingRoster(
      proposerRoster,
      fromCounter.map(ref),
      fromProposer.map((i) => i.playerId),
      lg.rosterSize,
    );
    validateResultingRoster(
      counterRoster,
      fromProposer.map(ref),
      fromCounter.map((i) => i.playerId),
      lg.rosterSize,
    );

    // Move the slots (delete + insert keeps the PK sane) and append ledger.
    for (const item of items) {
      const [slot] = await tx
        .select()
        .from(rosterSlot)
        .where(
          and(
            eq(rosterSlot.fantasyTeamId, item.fromTeamId),
            eq(rosterSlot.playerId, item.playerId),
          ),
        );
      if (!slot) {
        throw new TransactionError(
          `slot for player ${item.playerId} vanished mid-trade`,
          "TRADE_STALE",
        );
      }
      await tx
        .delete(rosterSlot)
        .where(
          and(
            eq(rosterSlot.fantasyTeamId, item.fromTeamId),
            eq(rosterSlot.playerId, item.playerId),
          ),
        );
      await tx.insert(rosterSlot).values({
        fantasyTeamId: item.toTeamId,
        playerId: item.playerId,
        leagueId: t.leagueId,
        draftedPosition: slot.draftedPosition,
        draftedAt: slot.draftedAt,
      });
      await tx.insert(rosterTransaction).values({
        leagueId: t.leagueId,
        kind: "TRADE",
        playerId: item.playerId,
        fromFantasyTeamId: item.fromTeamId,
        toFantasyTeamId: item.toTeamId,
        effectiveOrdinal,
        tradeId: t.id,
        createdAt: now,
      });
    }
    const [updated] = await tx
      .update(trade)
      .set({ status: "ACCEPTED", resolvedAt: now })
      .where(and(eq(trade.id, t.id), eq(trade.status, "PROPOSED")))
      .returning();
    if (!updated) {
      throw new TransactionError(
        "trade was resolved concurrently",
        "TRADE_NOT_PROPOSED",
      );
    }
    return updated;
  });

  await recordEvent(db, input.leagueId, "TRADE_EXECUTED", {
    tradeId: t.id,
    proposerTeamId: t.proposerTeamId,
    counterpartyTeamId: t.counterpartyTeamId,
    playerIds: items.map((i) => i.playerId),
    effectiveOrdinal,
  });
  const [proposer] = await db
    .select({ managerId: fantasyTeam.managerId })
    .from(fantasyTeam)
    .where(eq(fantasyTeam.id, t.proposerTeamId));
  if (proposer) {
    await enqueue(db, {
      managerId: proposer.managerId,
      type: "TRADE_RESULT",
      title: "Trade accepted",
      body: "Your trade offer was accepted and has been executed.",
      leagueId: input.leagueId,
      link: `/leagues/${input.leagueId}/transactions`,
      dedupeKey: `trade-result:${t.id}`,
    });
  }
  return { trade: executed, items };
}

// --- hub (read model for the transactions tab) ---------------------------------------

export interface TransactionHub {
  myTeamId: number;
  waiverHours: number;
  teams: { id: number; name: string; managerId: number }[];
  myRoster: { playerId: number; fullName: string; position: Position }[];
  /** Every team's current roster (league-visible, powers the trade builder). */
  rostersByTeam: Record<
    number,
    { playerId: number; fullName: string; position: Position }[]
  >;
  freeAgents: {
    playerId: number;
    fullName: string;
    position: Position;
    nationalTeamId: number;
    onWaiversUntil: string | null;
  }[];
  myClaims: (WaiverClaimRow & {
    addPlayerName: string | null;
    dropPlayerName: string | null;
  })[];
  trades: (TradeWithItems & {
    proposerTeamName: string;
    counterpartyTeamName: string;
    playerNames: Record<number, string>;
  })[];
  ledger: (RosterTransactionRow & {
    playerName: string | null;
    fromTeamName: string | null;
    toTeamName: string | null;
  })[];
}

/** Everything the transactions tab renders, in one read. */
export async function getTransactionHub(
  db: Db,
  leagueId: number,
  managerId: number,
  now: Date = new Date(),
): Promise<TransactionHub> {
  const { waiverHours } = await requireTransactions(db, leagueId, managerId);
  const myTeam = await teamOf(db, leagueId, managerId);

  const teams = await db
    .select({
      id: fantasyTeam.id,
      name: fantasyTeam.name,
      managerId: fantasyTeam.managerId,
    })
    .from(fantasyTeam)
    .where(eq(fantasyTeam.leagueId, leagueId));
  const teamNameById = new Map(teams.map((t) => [t.id, t.name]));

  const allPlayers = await db
    .select({
      id: player.id,
      fullName: player.fullName,
      position: player.position,
      nationalTeamId: player.nationalTeamId,
    })
    .from(player);
  const playerById = new Map(allPlayers.map((p) => [p.id, p]));

  const slots = await db
    .select()
    .from(rosterSlot)
    .where(eq(rosterSlot.leagueId, leagueId));
  const rosteredIds = new Set(slots.map((s) => s.playerId));

  const waivers = await db
    .select()
    .from(playerWaiver)
    .where(eq(playerWaiver.leagueId, leagueId));
  const waiverUntilByPlayer = new Map<number, Date>();
  for (const w of waivers) {
    if (w.untilUtc > now) waiverUntilByPlayer.set(w.playerId, w.untilUtc);
  }

  const freeAgents = allPlayers
    .filter((p) => !rosteredIds.has(p.id))
    .map((p) => ({
      playerId: p.id,
      fullName: p.fullName,
      position: p.position,
      nationalTeamId: p.nationalTeamId,
      onWaiversUntil: waiverUntilByPlayer.get(p.id)?.toISOString() ?? null,
    }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));

  const rostersByTeam: TransactionHub["rostersByTeam"] = {};
  for (const s of slots) {
    const p = playerById.get(s.playerId);
    const entry = {
      playerId: s.playerId,
      fullName: p?.fullName ?? `#${s.playerId}`,
      position: (p?.position ?? "MID") as Position,
    };
    (rostersByTeam[s.fantasyTeamId] ??= []).push(entry);
  }
  for (const list of Object.values(rostersByTeam)) {
    list.sort((a, b) => a.fullName.localeCompare(b.fullName));
  }
  const myRoster = rostersByTeam[myTeam.id] ?? [];

  const myClaims = (
    await db
      .select()
      .from(waiverClaim)
      .where(
        and(
          eq(waiverClaim.leagueId, leagueId),
          eq(waiverClaim.fantasyTeamId, myTeam.id),
        ),
      )
      .orderBy(asc(waiverClaim.id))
  ).map((c) => ({
    ...c,
    addPlayerName: playerById.get(c.addPlayerId)?.fullName ?? null,
    dropPlayerName:
      c.dropPlayerId !== null
        ? (playerById.get(c.dropPlayerId)?.fullName ?? null)
        : null,
  }));

  const tradeRows = await db
    .select()
    .from(trade)
    .where(eq(trade.leagueId, leagueId))
    .orderBy(asc(trade.id));
  const tradeIds = tradeRows.map((t) => t.id);
  const itemRows =
    tradeIds.length > 0
      ? await db.select().from(tradeItem).where(inArray(tradeItem.tradeId, tradeIds))
      : [];
  const itemsByTrade = new Map<number, TradeItemRow[]>();
  for (const i of itemRows) {
    const list = itemsByTrade.get(i.tradeId) ?? [];
    list.push(i);
    itemsByTrade.set(i.tradeId, list);
  }
  const trades = tradeRows.slice(-20).map((t) => {
    const items = itemsByTrade.get(t.id) ?? [];
    const playerNames: Record<number, string> = {};
    for (const i of items) {
      playerNames[i.playerId] = playerById.get(i.playerId)?.fullName ?? `#${i.playerId}`;
    }
    return {
      trade: t,
      items,
      proposerTeamName: teamNameById.get(t.proposerTeamId) ?? `team ${t.proposerTeamId}`,
      counterpartyTeamName:
        teamNameById.get(t.counterpartyTeamId) ?? `team ${t.counterpartyTeamId}`,
      playerNames,
    };
  });

  const ledgerRows = await db
    .select()
    .from(rosterTransaction)
    .where(eq(rosterTransaction.leagueId, leagueId))
    .orderBy(asc(rosterTransaction.id));
  const ledger = ledgerRows.slice(-30).map((r) => ({
    ...r,
    playerName: playerById.get(r.playerId)?.fullName ?? null,
    fromTeamName:
      r.fromFantasyTeamId !== null
        ? (teamNameById.get(r.fromFantasyTeamId) ?? null)
        : null,
    toTeamName:
      r.toFantasyTeamId !== null
        ? (teamNameById.get(r.toFantasyTeamId) ?? null)
        : null,
  }));

  return {
    myTeamId: myTeam.id,
    waiverHours,
    teams,
    myRoster,
    rostersByTeam,
    freeAgents,
    myClaims,
    trades,
    ledger,
  };
}
