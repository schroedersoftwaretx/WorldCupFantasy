/**
 * Draft results read model (post-draft improvements, A1 + A2).
 *
 * Everything the /leagues/[id]/draft/results page needs, in one query
 * helper: the full pick-by-pick board (round x draft slot), per-team
 * projected totals with a curved letter grade, and the draft's best
 * values / biggest reaches.
 *
 * Projections: we sum projected_score_entry across ALL fixtures (not just
 * SCHEDULED ones, as the live draft board does) so the numbers keep
 * approximating "projection as of the draft" even after matches finish.
 *
 * Value score: a player's value at pick N is (pickNumber - projectedRank),
 * where projectedRank ranks the WHOLE ingested player pool by projected
 * points. Positive = a steal (a top-20 player taken 80th); negative = a
 * reach. (The plan doc wrote the subtraction the other way round, but this
 * orientation is what makes "large positive = steal" true.)
 *
 * Pure read - derived entirely from data already in the DB.
 */
import { asc, eq, inArray, sql } from "drizzle-orm";

import type { Db } from "../data/db/client.js";
import {
  draftOrder,
  draftPick,
  draftRoom,
  fantasyTeam,
  league,
  manager,
  nationalTeam,
  player,
  projectedScoreEntry,
  type DraftStatus,
} from "../data/db/schema.js";
import { DEFAULT_RULESET } from "../data/scoring/ruleset.js";

export interface DraftResultsPick {
  pickNumber: number;
  round: number;
  /** 1-based round-1 draft slot of the team that made this pick. */
  slot: number;
  fantasyTeamId: number;
  teamName: string;
  playerId: number;
  playerName: string;
  position: string;
  nationalTeam: string;
  isAutopick: boolean;
  /** Projected fantasy points (null when projections are not ingested). */
  projectedPoints: number | null;
  /** 1-based rank in the whole player pool by projected points. */
  projectedRank: number | null;
  /** pickNumber - projectedRank; positive = steal, negative = reach. */
  value: number | null;
}

export interface DraftResultsTeam {
  fantasyTeamId: number;
  teamName: string;
  managerName: string;
  /** 1-based round-1 draft slot (column order of the board). */
  slot: number;
  /** Sum of the team's drafted players' projected points. */
  projectedTotal: number | null;
  /** Curved letter grade (A+ .. D), null when projections are missing. */
  grade: string | null;
}

export interface DraftResultsData {
  leagueId: number;
  leagueName: string;
  status: DraftStatus;
  rounds: number;
  /** Teams in draft-slot order: the board's columns. */
  teams: DraftResultsTeam[];
  /** Every pick in pick-number order. */
  picks: DraftResultsPick[];
  /** Top picks by value (steals), best first. */
  bestValues: DraftResultsPick[];
  /** Bottom picks by value (reaches), worst first. */
  biggestReaches: DraftResultsPick[];
  /** Whether any projections existed to grade against. */
  hasProjections: boolean;
}

/** Round to 1dp for display-friendly projected totals. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Map a z-score (team projected total vs league mean/stdev) to a letter
 * grade on a curve. Exported for unit tests.
 */
export function letterGrade(z: number): string {
  if (z >= 1.5) return "A+";
  if (z >= 1.0) return "A";
  if (z >= 0.5) return "A-";
  if (z >= 0.15) return "B+";
  if (z > -0.15) return "B";
  if (z > -0.5) return "B-";
  if (z > -1.0) return "C+";
  if (z > -1.5) return "C";
  return "D";
}

/** Grades for a list of team totals (same order). Exported for tests. */
export function gradeTotals(totals: readonly number[]): string[] {
  const n = totals.length;
  if (n === 0) return [];
  const mean = totals.reduce((a, b) => a + b, 0) / n;
  const variance =
    totals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  const stdev = Math.sqrt(variance);
  if (stdev === 0) return totals.map(() => "B");
  return totals.map((t) => letterGrade((t - mean) / stdev));
}

/**
 * The full draft-results view for a league, or null when the league has no
 * draft room yet. Works for an in-progress draft too (the page gates on
 * status itself).
 */
export async function getDraftResults(
  db: Db,
  leagueId: number,
): Promise<DraftResultsData | null> {
  const [lg] = await db.select().from(league).where(eq(league.id, leagueId));
  if (!lg) throw new Error(`league ${leagueId} does not exist`);

  const [room] = await db
    .select()
    .from(draftRoom)
    .where(eq(draftRoom.leagueId, leagueId));
  if (!room) return null;

  // --- order, teams, managers --------------------------------------------
  const orderRows = await db
    .select()
    .from(draftOrder)
    .where(eq(draftOrder.draftRoomId, room.id))
    .orderBy(asc(draftOrder.slot));
  const slotByTeam = new Map(orderRows.map((o) => [o.fantasyTeamId, o.slot]));

  const teams = await db
    .select()
    .from(fantasyTeam)
    .where(eq(fantasyTeam.leagueId, leagueId));
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const managerIds = teams.map((t) => t.managerId);
  const managers =
    managerIds.length > 0
      ? await db.select().from(manager).where(inArray(manager.id, managerIds))
      : [];
  const managerById = new Map(managers.map((m) => [m.id, m]));

  // --- picks + their players ----------------------------------------------
  const pickRows = await db
    .select()
    .from(draftPick)
    .where(eq(draftPick.draftRoomId, room.id))
    .orderBy(asc(draftPick.pickNumber));
  const pickPlayerIds = pickRows.map((p) => p.playerId);
  const players =
    pickPlayerIds.length > 0
      ? await db
          .select({
            id: player.id,
            fullName: player.fullName,
            position: player.position,
            nationalTeam: nationalTeam.name,
          })
          .from(player)
          .innerJoin(nationalTeam, eq(nationalTeam.id, player.nationalTeamId))
          .where(inArray(player.id, pickPlayerIds))
      : [];
  const playerById = new Map(players.map((p) => [p.id, p]));

  // --- projections over the WHOLE pool, for ranks + grades -----------------
  // (try-catch so the page still renders if the table is unmigrated)
  const projByPlayer = new Map<number, number>();
  try {
    const projRows = await db
      .select({
        playerId: projectedScoreEntry.playerId,
        total: sql<number>`sum(${projectedScoreEntry.projectedPoints})`,
      })
      .from(projectedScoreEntry)
      .where(eq(projectedScoreEntry.rulesetVersion, DEFAULT_RULESET.version))
      .groupBy(projectedScoreEntry.playerId);
    for (const r of projRows) projByPlayer.set(r.playerId, r.total);
  } catch {
    // no projections - values/grades render as "-"
  }
  const hasProjections = projByPlayer.size > 0;

  // projectedRank: 1 = best projected player in the entire ingested pool.
  const rankByPlayer = new Map<number, number>();
  const rankedPool = Array.from(projByPlayer.entries()).sort(
    (a, b) => b[1] - a[1] || a[0] - b[0],
  );
  rankedPool.forEach(([pid], i) => rankByPlayer.set(pid, i + 1));

  // --- assemble picks ------------------------------------------------------
  const picks: DraftResultsPick[] = pickRows.map((p) => {
    const pl = playerById.get(p.playerId);
    const proj = projByPlayer.get(p.playerId);
    const rank = rankByPlayer.get(p.playerId);
    return {
      pickNumber: p.pickNumber,
      round: p.round,
      slot: slotByTeam.get(p.fantasyTeamId) ?? 0,
      fantasyTeamId: p.fantasyTeamId,
      teamName: teamById.get(p.fantasyTeamId)?.name ?? `team #${p.fantasyTeamId}`,
      playerId: p.playerId,
      playerName: pl?.fullName ?? `player #${p.playerId}`,
      position: pl?.position ?? "?",
      nationalTeam: pl?.nationalTeam ?? "",
      isAutopick: p.isAutopick,
      projectedPoints: proj !== undefined ? round1(proj) : null,
      projectedRank: rank ?? null,
      value: rank !== undefined ? p.pickNumber - rank : null,
    };
  });

  // --- team totals + grades ------------------------------------------------
  const totalByTeam = new Map<number, number>();
  for (const p of picks) {
    if (p.projectedPoints === null) continue;
    totalByTeam.set(
      p.fantasyTeamId,
      (totalByTeam.get(p.fantasyTeamId) ?? 0) + p.projectedPoints,
    );
  }

  const orderedTeams = orderRows.map((o) => {
    const t = teamById.get(o.fantasyTeamId);
    const m = t ? managerById.get(t.managerId) : undefined;
    return {
      fantasyTeamId: o.fantasyTeamId,
      teamName: t?.name ?? `team #${o.fantasyTeamId}`,
      managerName: m?.displayName ?? "-",
      slot: o.slot,
      projectedTotal: hasProjections
        ? round1(totalByTeam.get(o.fantasyTeamId) ?? 0)
        : null,
    };
  });
  const grades = gradeTotals(
    hasProjections ? orderedTeams.map((t) => t.projectedTotal ?? 0) : [],
  );
  const teamsOut: DraftResultsTeam[] = orderedTeams.map((t, i) => ({
    ...t,
    grade: grades[i] ?? null,
  }));

  // --- steals & reaches ----------------------------------------------------
  const valued = picks.filter((p) => p.value !== null);
  const bestValues = [...valued]
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    .slice(0, 5)
    .filter((p) => (p.value ?? 0) > 0);
  const biggestReaches = [...valued]
    .sort((a, b) => (a.value ?? 0) - (b.value ?? 0))
    .slice(0, 5)
    .filter((p) => (p.value ?? 0) < 0);

  const rounds =
    orderRows.length > 0
      ? Math.max(lg.rosterSize, Math.ceil(pickRows.length / orderRows.length))
      : 0;

  return {
    leagueId,
    leagueName: lg.name,
    status: room.status,
    rounds,
    teams: teamsOut,
    picks,
    bestValues,
    biggestReaches,
    hasProjections,
  };
}
