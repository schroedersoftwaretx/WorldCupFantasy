/**
 * Draft-room read model for the web app (W4).
 *
 * Assembles the full draft-room view a browser needs - the snake order with
 * names, who is on the clock, the deadline, the picks log, and the viewer's
 * own roster - and the player board (available players, each flagged with
 * whether it would be a legal pick for the viewer). Pure reads; every write
 * goes through the backend draft service.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { Db } from "../data/db/client.js";
import {
  draftOrder,
  draftPick,
  draftRoom,
  fantasyTeam,
  fixture,
  league,
  leagueMembership,
  manager,
  nationalTeam,
  player,
  projectedScoreEntry,
  rosterSlot,
  stageOdds,
  STAGE_ODDS_STAGES,
  type DraftRoomRow,
  type FantasyTeamRow,
  type Position,
  type StageOddsStage,
} from "../data/db/schema.js";
import { DEFAULT_RULESET } from "../data/scoring/ruleset.js";
import { adpByPlayerId } from "../data/stats/adp.js";
import { roundForPick, slotForPick } from "../data/draft/snake.js";
import { canAddPlayer, countsFromPositions } from "../data/roster/validator.js";
import type {
  DraftBoardData,
  DraftBoardPlayer,
  DraftOrderSlot,
  DraftPickLog,
  DraftRosterPlayer,
  DraftStateData,
  DraftViewer,
} from "./api-types.js";

/** Find a league's draft room, or null if it has none yet. */
export async function findDraftRoom(
  db: Db,
  leagueId: number,
): Promise<DraftRoomRow | null> {
  const [room] = await db
    .select()
    .from(draftRoom)
    .where(eq(draftRoom.leagueId, leagueId));
  return room ?? null;
}

/** The given manager's fantasy team in a league, or null. */
export async function getManagerTeam(
  db: Db,
  leagueId: number,
  managerId: number,
): Promise<FantasyTeamRow | null> {
  const [team] = await db
    .select()
    .from(fantasyTeam)
    .where(
      and(
        eq(fantasyTeam.leagueId, leagueId),
        eq(fantasyTeam.managerId, managerId),
      ),
    );
  return team ?? null;
}

async function isLeagueOwner(
  db: Db,
  leagueId: number,
  managerId: number,
): Promise<boolean> {
  const [m] = await db
    .select()
    .from(leagueMembership)
    .where(
      and(
        eq(leagueMembership.leagueId, leagueId),
        eq(leagueMembership.managerId, managerId),
      ),
    );
  return m?.role === "OWNER";
}

/** The full draft-room view for one viewer. */
/** Fetch the draft room row for a league, or null if none exists. */
export async function getDraftRoomRow(
  db: Db,
  leagueId: number,
): Promise<DraftRoomRow | null> {
  const [row] = await db
    .select()
    .from(draftRoom)
    .where(eq(draftRoom.leagueId, leagueId));
  return row ?? null;
}

export async function getDraftRoomView(
  db: Db,
  leagueId: number,
  viewerManagerId: number,
): Promise<DraftStateData> {
  const [lg] = await db.select().from(league).where(eq(league.id, leagueId));
  if (!lg) throw new Error(`league ${leagueId} not found`);

  const team = await getManagerTeam(db, leagueId, viewerManagerId);
  if (!team) throw new Error("you have no team in this league");
  const owner = await isLeagueOwner(db, leagueId, viewerManagerId);
  const room = await findDraftRoom(db, leagueId);

  // Teams + managers in the league, for naming order slots and picks.
  const teams = await db
    .select()
    .from(fantasyTeam)
    .where(eq(fantasyTeam.leagueId, leagueId));
  const managerIds = teams.map((t) => t.managerId);
  const managers =
    managerIds.length > 0
      ? await db.select().from(manager).where(inArray(manager.id, managerIds))
      : [];
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const managerById = new Map(managers.map((m) => [m.id, m]));
  const teamName = (id: number): string => teamById.get(id)?.name ?? `team #${id}`;
  const managerName = (teamId: number): string => {
    const t = teamById.get(teamId);
    const m = t ? managerById.get(t.managerId) : undefined;
    return m?.displayName ?? "-";
  };

  if (!room) {
    return {
      status: "NONE",
      draftRoomId: null,
      pickTimerHours: null,
      rosterSize: lg.rosterSize,
      teamCount: teams.length,
      totalPicks: 0,
      picksMade: 0,
      currentPickNumber: null,
      currentRound: null,
      currentPickDeadline: null,
      onClockTeamId: null,
      order: [],
      picks: [],
      viewer: emptyViewer(team, owner),
      emailNotifications: Boolean(process.env["RESEND_API_KEY"]),
    };
  }

  // Frozen draft order.
  const orderRows = await db
    .select()
    .from(draftOrder)
    .where(eq(draftOrder.draftRoomId, room.id))
    .orderBy(asc(draftOrder.slot));
  const order: DraftOrderSlot[] = orderRows.map((o) => ({
    slot: o.slot,
    fantasyTeamId: o.fantasyTeamId,
    teamName: teamName(o.fantasyTeamId),
    managerName: managerName(o.fantasyTeamId),
  }));
  const orderTeamIds = orderRows.map((o) => o.fantasyTeamId);

  // Picks log + the players they reference.
  const pickRows = await db
    .select()
    .from(draftPick)
    .where(eq(draftPick.draftRoomId, room.id))
    .orderBy(asc(draftPick.pickNumber));
  const pickPlayerIds = pickRows.map((p) => p.playerId);
  const pickPlayers =
    pickPlayerIds.length > 0
      ? await db.select().from(player).where(inArray(player.id, pickPlayerIds))
      : [];
  const playerById = new Map(pickPlayers.map((p) => [p.id, p]));
  const picks: DraftPickLog[] = pickRows.map((p) => {
    const pl = playerById.get(p.playerId);
    return {
      pickNumber: p.pickNumber,
      round: p.round,
      fantasyTeamId: p.fantasyTeamId,
      teamName: teamName(p.fantasyTeamId),
      playerId: p.playerId,
      playerName: pl?.fullName ?? `player #${p.playerId}`,
      position: pl?.position ?? "?",
      isAutopick: p.isAutopick,
    };
  });

  // Who is on the clock.
  let onClockTeamId: number | null = null;
  let currentRound: number | null = null;
  if (
    room.status === "IN_PROGRESS" &&
    room.currentPickNumber !== null &&
    orderTeamIds.length > 0
  ) {
    const n = orderTeamIds.length;
    onClockTeamId = orderTeamIds[slotForPick(room.currentPickNumber, n) - 1] ?? null;
    currentRound = roundForPick(room.currentPickNumber, n);
  }

  // The viewer's roster, derived from their own picks.
  const myPickRows = pickRows.filter((p) => p.fantasyTeamId === team.id);
  const roster: DraftRosterPlayer[] = myPickRows.map((p) => {
    const pl = playerById.get(p.playerId);
    return {
      playerId: p.playerId,
      fullName: pl?.fullName ?? `player #${p.playerId}`,
      position: pl?.position ?? "?",
      draftRank: pl?.draftRank ?? null,
    };
  });
  const counts = countsFromPositions(
    myPickRows
      .map((p) => playerById.get(p.playerId)?.position)
      .filter((x): x is Position => x !== undefined),
  );

  return {
    status: room.status,
    draftRoomId: room.id,
    pickTimerHours: room.pickTimerHours,
    rosterSize: lg.rosterSize,
    teamCount: teams.length,
    totalPicks: room.totalPicks,
    picksMade: pickRows.length,
    currentPickNumber: room.currentPickNumber,
    currentRound,
    currentPickDeadline: room.currentPickDeadline
      ? room.currentPickDeadline.toISOString()
      : null,
    onClockTeamId,
    order,
    picks,
    viewer: {
      managerId: viewerManagerId,
      fantasyTeamId: team.id,
      teamName: team.name,
      isOwner: owner,
      isOnClock: onClockTeamId === team.id,
      roster,
      counts,
    },
    emailNotifications: Boolean(process.env["RESEND_API_KEY"]),
  };
}

function emptyViewer(team: FantasyTeamRow, owner: boolean): DraftViewer {
  return {
    managerId: team.managerId,
    fantasyTeamId: team.id,
    teamName: team.name,
    isOwner: owner,
    isOnClock: false,
    roster: [],
    counts: { GK: 0, DEF: 0, MID: 0, FWD: 0 },
  };
}

/** The available-player board, with each player flagged for legality. */
export async function getDraftBoard(
  db: Db,
  leagueId: number,
  viewerManagerId: number,
): Promise<DraftBoardData> {
  const team = await getManagerTeam(db, leagueId, viewerManagerId);
  if (!team) throw new Error("you have no team in this league");

  // The viewer's current position counts.
  const mySlots = await db
    .select({ position: rosterSlot.draftedPosition })
    .from(rosterSlot)
    .where(eq(rosterSlot.fantasyTeamId, team.id));
  const counts = countsFromPositions(mySlots.map((s) => s.position));

  // Players already taken anywhere in this league.
  const taken = await db
    .select({ playerId: rosterSlot.playerId })
    .from(rosterSlot)
    .where(eq(rosterSlot.leagueId, leagueId));
  const takenIds = new Set(taken.map((t) => t.playerId));

  // Every player with its national team.
  const rows = await db
    .select({
      id: player.id,
      fullName: player.fullName,
      position: player.position,
      draftRank: player.draftRank,
      nationalTeamId: player.nationalTeamId,
      nationalTeam: nationalTeam.name,
    })
    .from(player)
    .innerJoin(nationalTeam, eq(nationalTeam.id, player.nationalTeamId));

  // Per national team: the market-implied probability of REACHING each
  // tournament stage (Round of 16 .. Champion), from the stage_odds table.
  // Replaces the old "next-match win %" — far more useful for a draft, where
  // you care how deep a player's team is likely to go (more games = more
  // fantasy points). Wrapped in try-catch so the board still loads if
  // stage_odds is missing/unmigrated.
  const stageByTeam = new Map<number, Partial<Record<StageOddsStage, number>>>();
  try {
    const stageRows = await db
      .select({
        teamId: stageOdds.nationalTeamId,
        stage: stageOdds.stage,
        reachP: stageOdds.reachP,
      })
      .from(stageOdds);
    const known = new Set<string>(STAGE_ODDS_STAGES);
    for (const r of stageRows) {
      if (!known.has(r.stage)) continue;
      const entry = stageByTeam.get(r.teamId) ?? {};
      entry[r.stage as StageOddsStage] = r.reachP;
      stageByTeam.set(r.teamId, entry);
    }
  } catch {
    // stage_odds not migrated/populated — stage probabilities show as null.
  }

  // Projected total points per player: sum of projected_score_entry for all
  // SCHEDULED fixtures using the current ruleset.
  // Wrapped in try-catch so the board still loads if the table doesn't exist
  // yet (e.g. migration hasn't been applied to the local dev DB).
  let projByPlayer = new Map<number, number>();
  try {
    const projRows = await db
      .select({
        playerId: projectedScoreEntry.playerId,
        total: sql<number>`sum(${projectedScoreEntry.projectedPoints})`,
      })
      .from(projectedScoreEntry)
      .innerJoin(fixture, eq(projectedScoreEntry.fixtureId, fixture.id))
      .where(
        and(
          eq(projectedScoreEntry.rulesetVersion, DEFAULT_RULESET.version),
          eq(fixture.status, "SCHEDULED"),
        ),
      )
      .groupBy(projectedScoreEntry.playerId);
    projByPlayer = new Map<number, number>(
      projRows.map((r) => [r.playerId, r.total]),
    );
  } catch {
    // Table not yet migrated — projected points will show as null.
  }

  // Live ADP overlay (Phase 2): cross-league average draft position per
  // player. Read-only context next to the board; never affects pick/autopick
  // logic. Wrapped so the board still loads if no drafts exist yet.
  let adpByPlayer = new Map<number, number>();
  try {
    const adpRes = await adpByPlayerId(db, {});
    adpByPlayer = new Map(Array.from(adpRes.byPlayerId, ([id, v]) => [id, v.adp]));
  } catch {
    // No drafts yet — ADP shows as null.
  }

  const players: DraftBoardPlayer[] = rows
    .filter((r) => !takenIds.has(r.id))
    .map((r) => ({
      id: r.id,
      fullName: r.fullName,
      position: r.position,
      nationalTeam: r.nationalTeam,
      draftRank: r.draftRank,
      projectedTotalPoints: projByPlayer.get(r.id) ?? null,
      stageProbabilities: stageByTeam.get(r.nationalTeamId) ?? null,
      adp: adpByPlayer.get(r.id) ?? null,
      legal: canAddPlayer(counts, r.position).ok,
    }))
    .sort((a, b) => {
      // Default sort: projected total points desc, then draft rank, then name.
      const pa = a.projectedTotalPoints ?? -1;
      const pb = b.projectedTotalPoints ?? -1;
      if (pb !== pa) return pb - pa;
      const ra = a.draftRank ?? Number.MAX_SAFE_INTEGER;
      const rb = b.draftRank ?? Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      return a.fullName.localeCompare(b.fullName);
    });

  return { players };
}
