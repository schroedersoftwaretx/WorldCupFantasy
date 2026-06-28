/**
 * Nation-level stat leaders and the position scarcity heatmap.
 *
 * Extracted from aggregate.ts (tech-debt #3). Behavior-preserving: identical SQL
 * and in-memory aggregation. Re-exported via the aggregate.ts barrel.
 */
import { eq, inArray } from "drizzle-orm";

import type { Db, DbTx } from "../db/client.js";
import {
  fixture,
  nationalTeam,
  player,
  scoreEntry,
  statLine,
  type Position,
  type Stage,
} from "../db/schema.js";
import {
  METRIC_COLUMN,
  POSITION_ORDER,
  STAGE_ORDER,
  fixtureIdsForStage,
  round2,
  type StatMetric,
} from "./refs.js";
import type { StatLeadersQuery } from "./scoring.js";

// --- Phase 1: nation stat leaders --------------------------------------------

export interface NationStatTotal {
  nationalTeamId: number;
  nationalTeamName: string;
  metric: StatMetric;
  total: number;
}

/**
 * Leaders by a raw counting stat aggregated to the national-team level (e.g.
 * "most goals by one nation's players"), optionally within a stage.
 */
export async function nationStatLeaders(
  db: Db | DbTx,
  query: StatLeadersQuery,
): Promise<NationStatTotal[]> {
  const limit = query.limit ?? 10;
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
  if (rows.length === 0) return [];

  const playerIds = Array.from(new Set(rows.map((r) => r.playerId)));
  const players = await db
    .select({ id: player.id, nationalTeamId: player.nationalTeamId })
    .from(player)
    .where(inArray(player.id, playerIds));
  const teamOf = new Map(players.map((p) => [p.id, p.nationalTeamId]));

  const sum = new Map<number, number>();
  for (const r of rows) {
    const tid = teamOf.get(r.playerId);
    if (tid === undefined) continue;
    sum.set(tid, (sum.get(tid) ?? 0) + r.value);
  }
  const teamIds = Array.from(sum.keys());
  const teams =
    teamIds.length > 0
      ? await db
          .select()
          .from(nationalTeam)
          .where(inArray(nationalTeam.id, teamIds))
      : [];
  const teamName = new Map(teams.map((t) => [t.id, t.name]));

  const out: NationStatTotal[] = [];
  for (const [tid, total] of sum) {
    if (total === 0) continue;
    out.push({
      nationalTeamId: tid,
      nationalTeamName: teamName.get(tid) ?? "",
      metric: query.metric,
      total,
    });
  }
  out.sort((a, b) => b.total - a.total || a.nationalTeamId - b.nationalTeamId);
  return out.slice(0, limit);
}

// --- Phase 1: position scarcity heatmap --------------------------------------

export interface PositionStageAvg {
  stage: Stage;
  position: Position;
  /** Mean score_entry points across rows in this (stage, position) cell, 2dp. */
  avgPoints: number;
  /** Number of score_entry rows in the cell. */
  entries: number;
  /** Total points in the cell, 2dp. */
  totalPoints: number;
}

/**
 * Average fantasy points by (stage, position) - a cheap scarcity heatmap of
 * where points are concentrated. One row per non-empty (stage, position) cell,
 * ordered by tournament stage then keeper-to-forward.
 */
export async function positionScarcity(
  db: Db | DbTx,
  rulesetVersion: string,
): Promise<PositionStageAvg[]> {
  const scores = await db
    .select()
    .from(scoreEntry)
    .where(eq(scoreEntry.rulesetVersion, rulesetVersion));
  if (scores.length === 0) return [];

  const fixtures = await db
    .select({ id: fixture.id, stage: fixture.stage })
    .from(fixture);
  const stageOf = new Map(fixtures.map((f) => [f.id, f.stage]));
  const playerIds = Array.from(new Set(scores.map((s) => s.playerId)));
  const players = await db
    .select({ id: player.id, position: player.position })
    .from(player)
    .where(inArray(player.id, playerIds));
  const posOf = new Map(players.map((p) => [p.id, p.position]));

  const cell = new Map<
    string,
    { stage: Stage; position: Position; total: number; entries: number }
  >();
  for (const s of scores) {
    const stage = stageOf.get(s.fixtureId);
    const position = posOf.get(s.playerId);
    if (!stage || !position) continue;
    const key = `${stage}|${position}`;
    const c = cell.get(key) ?? { stage, position, total: 0, entries: 0 };
    c.total += s.points;
    c.entries += 1;
    cell.set(key, c);
  }

  const stageIdx = (s: Stage): number => STAGE_ORDER.indexOf(s);
  const posIdx = (p: Position): number => POSITION_ORDER.indexOf(p);
  const out: PositionStageAvg[] = [];
  for (const c of cell.values()) {
    out.push({
      stage: c.stage,
      position: c.position,
      avgPoints: round2(c.total / c.entries),
      entries: c.entries,
      totalPoints: round2(c.total),
    });
  }
  out.sort(
    (a, b) =>
      stageIdx(a.stage) - stageIdx(b.stage) || posIdx(a.position) - posIdx(b.position),
  );
  return out;
}
