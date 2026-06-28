/**
 * Fantasy-point scoring leaders and per-fixture points.
 *
 * Extracted from aggregate.ts (tech-debt #3). Behavior-preserving: identical SQL
 * and in-memory aggregation. Re-exported via the aggregate.ts barrel.
 */
import { and, eq, inArray } from "drizzle-orm";

import type { Db, DbTx } from "../db/client.js";
import { scoreEntry, statLine, type Position, type Stage } from "../db/schema.js";
import {
  METRIC_COLUMN,
  fixtureIdsForStage,
  loadRefs,
  round2,
  type PlayerPoints,
  type PlayerStatTotal,
  type StatMetric,
} from "./refs.js";

export interface TopScorersQuery {
  /** Which scoring ruleset's points to total (league.scoringRuleset.version). */
  rulesetVersion: string;
  /** Restrict to one stage's fixtures; omit for the whole tournament. */
  stage?: Stage;
  /** Restrict to one outfield/keeper position; omit for all positions. */
  position?: Position;
  /** Cap the result list. Default 20. */
  limit?: number;
}

/**
 * Top fantasy-point scorers for a ruleset, optionally within one stage.
 * Sorted by points desc, then appearances desc, then playerId asc.
 */
export async function topScorers(
  db: Db | DbTx,
  query: TopScorersQuery,
): Promise<PlayerPoints[]> {
  const limit = query.limit ?? 20;
  const stageFixtureIds = await fixtureIdsForStage(db, query.stage);
  if (stageFixtureIds !== null && stageFixtureIds.length === 0) return [];

  const where =
    stageFixtureIds === null
      ? eq(scoreEntry.rulesetVersion, query.rulesetVersion)
      : and(
          eq(scoreEntry.rulesetVersion, query.rulesetVersion),
          inArray(scoreEntry.fixtureId, stageFixtureIds),
        );
  const scores = await db.select().from(scoreEntry).where(where);

  const sum = new Map<number, { points: number; appearances: number }>();
  for (const s of scores) {
    const cur = sum.get(s.playerId) ?? { points: 0, appearances: 0 };
    cur.points += s.points;
    cur.appearances += 1;
    sum.set(s.playerId, cur);
  }

  const refs = await loadRefs(db, Array.from(sum.keys()));
  const rows: PlayerPoints[] = [];
  for (const [playerId, agg] of sum) {
    const ref = refs.get(playerId);
    if (!ref) continue;
    if (query.position && ref.position !== query.position) continue;
    rows.push({ ...ref, points: round2(agg.points), appearances: agg.appearances });
  }
  rows.sort(
    (a, b) =>
      b.points - a.points ||
      b.appearances - a.appearances ||
      a.playerId - b.playerId,
  );
  return rows.slice(0, limit);
}

/**
 * Per-player fantasy points for a single fixture, ruleset-scoped, sorted by
 * points desc then playerId asc. The building block for a "player points in
 * this match" view.
 */
export async function perFixturePlayerPoints(
  db: Db | DbTx,
  rulesetVersion: string,
  fixtureId: number,
): Promise<PlayerPoints[]> {
  const scores = await db
    .select()
    .from(scoreEntry)
    .where(
      and(
        eq(scoreEntry.rulesetVersion, rulesetVersion),
        eq(scoreEntry.fixtureId, fixtureId),
      ),
    );
  const refs = await loadRefs(db, scores.map((s) => s.playerId));
  const rows: PlayerPoints[] = [];
  for (const s of scores) {
    const ref = refs.get(s.playerId);
    if (!ref) continue;
    rows.push({ ...ref, points: round2(s.points), appearances: 1 });
  }
  rows.sort((a, b) => b.points - a.points || a.playerId - b.playerId);
  return rows;
}

export interface StatLeadersQuery {
  metric: StatMetric;
  /** Restrict to one stage's fixtures; omit for the whole tournament. */
  stage?: Stage;
  /** Cap the result list. Default 20. */
  limit?: number;
}

/**
 * Leaders by a raw counting stat from stat_line (the immutable source of
 * truth), optionally within one stage. Sorted by total desc, then playerId asc.
 */
export async function statLeaders(
  db: Db | DbTx,
  query: StatLeadersQuery,
): Promise<PlayerStatTotal[]> {
  const limit = query.limit ?? 20;
  const column = METRIC_COLUMN[query.metric];
  const stageFixtureIds = await fixtureIdsForStage(db, query.stage);
  if (stageFixtureIds !== null && stageFixtureIds.length === 0) return [];

  const rows =
    stageFixtureIds === null
      ? await db
          .select({ playerId: statLine.playerId, value: column })
          .from(statLine)
      : await db
          .select({ playerId: statLine.playerId, value: column })
          .from(statLine)
          .where(inArray(statLine.fixtureId, stageFixtureIds));

  const sum = new Map<number, number>();
  for (const r of rows) {
    sum.set(r.playerId, (sum.get(r.playerId) ?? 0) + r.value);
  }

  const refs = await loadRefs(db, Array.from(sum.keys()));
  const out: PlayerStatTotal[] = [];
  for (const [playerId, total] of sum) {
    const ref = refs.get(playerId);
    if (!ref || total === 0) continue;
    out.push({ ...ref, metric: query.metric, total });
  }
  out.sort((a, b) => b.total - a.total || a.playerId - b.playerId);
  return out.slice(0, limit);
}
