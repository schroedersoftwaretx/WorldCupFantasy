/**
 * Standings snapshots (post-draft improvements, B2).
 *
 * After each score recompute we persist, per league, one row per
 * (stage, fantasy team) with the team's CUMULATIVE rank and total through
 * the end of that stage. The standings page diffs the latest stage against
 * the previous one to render rank-movement arrows, and the top single-stage
 * scorer powers the "Manager of the Stage" badge.
 *
 * Everything rank-related is computed by the same rankStandings ladder the
 * live standings use, so a snapshot is exactly "what the standings page
 * showed at the end of that stage" (modulo later stat corrections - which
 * is why we persist instead of always deriving).
 *
 * The pure helpers (cumulativeTotalsThroughStage, latestScoredStage,
 * managerOfStage) are exported separately so they can be unit-tested and
 * reused by the page as a fallback when a snapshot row does not exist yet.
 */
import { eq } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { league, standingsSnapshot, type Stage } from "../db/schema.js";
import {
  computeStandings,
  rankStandings,
  SCORING_PERIODS,
  type StandingsEntry,
} from "./standings.js";

/** Round to 2dp - keeps snapshot totals consistent with the scoring engine. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Each team's cumulative total through the END of the given stage
 * (inclusive), from the live standings entries.
 */
export function cumulativeTotalsThroughStage(
  entries: readonly StandingsEntry[],
  stage: Stage,
): Map<number, number> {
  const stopIdx = SCORING_PERIODS.indexOf(stage);
  const totals = new Map<number, number>();
  for (const e of entries) {
    let sum = 0;
    for (const p of e.periods) {
      const idx = SCORING_PERIODS.indexOf(p.stage);
      if (idx !== -1 && idx <= stopIdx) sum += p.points;
    }
    totals.set(e.fantasyTeamId, round2(sum));
  }
  return totals;
}

/**
 * Rank teams by their cumulative totals through the given stage, using the
 * same tie-breaker ladder as the live standings. Returns
 * fantasyTeamId -> rank.
 */
export function cumulativeRanksThroughStage(
  entries: readonly StandingsEntry[],
  stage: Stage,
): Map<number, number> {
  const totals = cumulativeTotalsThroughStage(entries, stage);
  const ranked = rankStandings(
    entries.map((e) => ({
      fantasyTeamId: e.fantasyTeamId,
      managerId: e.managerId,
      teamName: e.teamName,
      total: totals.get(e.fantasyTeamId) ?? 0,
      tieBreakers: e.tieBreakers,
      periods: e.periods,
    })),
  );
  return new Map(ranked.map((e) => [e.fantasyTeamId, e.rank]));
}

/**
 * The stages that have any non-zero points in the league, in tournament
 * order. Empty before the first match is scored.
 */
export function scoredStages(entries: readonly StandingsEntry[]): Stage[] {
  return SCORING_PERIODS.filter((stage) =>
    entries.some(
      (e) => (e.periods.find((p) => p.stage === stage)?.points ?? 0) !== 0,
    ),
  );
}

/** The most recent stage with any points, or null pre-tournament. */
export function latestScoredStage(
  entries: readonly StandingsEntry[],
): Stage | null {
  const stages = scoredStages(entries);
  return stages.length > 0 ? (stages[stages.length - 1] ?? null) : null;
}

export interface ManagerOfStage {
  stage: Stage;
  /** Highest single-stage scorers (plural on a tie). */
  fantasyTeamIds: number[];
  points: number;
}

/**
 * The single highest-scoring team(s) of the most recent scored stage, or
 * null when nothing has been scored yet.
 */
export function managerOfStage(
  entries: readonly StandingsEntry[],
): ManagerOfStage | null {
  const stage = latestScoredStage(entries);
  if (!stage) return null;
  let best = -Infinity;
  let winners: number[] = [];
  for (const e of entries) {
    const pts = e.periods.find((p) => p.stage === stage)?.points ?? 0;
    if (pts > best) {
      best = pts;
      winners = [e.fantasyTeamId];
    } else if (pts === best) {
      winners.push(e.fantasyTeamId);
    }
  }
  if (winners.length === 0 || best <= 0) return null;
  return { stage, fantasyTeamIds: winners, points: best };
}

export interface SnapshotSummary {
  leagueId: number;
  /** Rows upserted (one per team per scored stage). */
  written: number;
}

/**
 * Persist cumulative rank/total snapshots for every scored stage of one
 * league. Idempotent: re-running after a stat correction simply overwrites
 * the affected rows with the corrected ranks.
 */
export async function captureStandingsSnapshots(
  db: Db,
  leagueId: number,
): Promise<SnapshotSummary> {
  const entries = await computeStandings(db, leagueId);
  if (entries.length === 0) return { leagueId, written: 0 };

  let written = 0;
  for (const stage of scoredStages(entries)) {
    const totals = cumulativeTotalsThroughStage(entries, stage);
    const ranks = cumulativeRanksThroughStage(entries, stage);
    for (const e of entries) {
      await db
        .insert(standingsSnapshot)
        .values({
          leagueId,
          stage,
          fantasyTeamId: e.fantasyTeamId,
          rank: ranks.get(e.fantasyTeamId) ?? 0,
          total: totals.get(e.fantasyTeamId) ?? 0,
          computedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            standingsSnapshot.leagueId,
            standingsSnapshot.stage,
            standingsSnapshot.fantasyTeamId,
          ],
          set: {
            rank: ranks.get(e.fantasyTeamId) ?? 0,
            total: totals.get(e.fantasyTeamId) ?? 0,
            computedAt: new Date(),
          },
        });
      written += 1;
    }
  }
  return { leagueId, written };
}

/**
 * Snapshot every league. Wrapped per-league in try-catch so one broken
 * league (or an unmigrated standings_snapshot table) cannot fail the cron's
 * scoring work.
 */
export async function captureAllStandingsSnapshots(
  db: Db,
): Promise<{ leagues: number; written: number; errors: number }> {
  const leagues = await db.select({ id: league.id }).from(league);
  let written = 0;
  let errors = 0;
  for (const lg of leagues) {
    try {
      const s = await captureStandingsSnapshots(db, lg.id);
      written += s.written;
    } catch {
      errors += 1;
    }
  }
  return { leagues: leagues.length, written, errors };
}

/**
 * Read one league's snapshot ranks for a single stage:
 * fantasyTeamId -> rank. Empty map when the stage has no snapshot yet (or
 * the table is unmigrated - the catch keeps the page rendering).
 */
export async function getSnapshotRanks(
  db: Db,
  leagueId: number,
  stage: Stage,
): Promise<Map<number, number>> {
  try {
    const rows = await db
      .select()
      .from(standingsSnapshot)
      .where(eq(standingsSnapshot.leagueId, leagueId));
    return new Map(
      rows.filter((r) => r.stage === stage).map((r) => [r.fantasyTeamId, r.rank]),
    );
  } catch {
    return new Map();
  }
}
