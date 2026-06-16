/**
 * Tournament stats aggregation (Phase 0 base layer).
 *
 * A read-only, pure aggregation layer over the scoring spine
 * (score_entry + stat_line + fixture) that the Stats Hub (Phase 1) and other
 * features build on. It never writes and never derives anything that is already
 * stored elsewhere: fantasy points come from score_entry (keyed by ruleset
 * version), raw counting stats from stat_line.
 *
 * Style mirrors standings.ts: a handful of bulk queries load everything, then
 * all computation is in-memory and pure - cheap for a single tournament.
 */
import { and, eq, inArray } from "drizzle-orm";

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

/** Identity of a player, denormalized with their national team, for display. */
export interface PlayerRef {
  playerId: number;
  fullName: string;
  position: Position;
  nationalTeamId: number;
  nationalTeamName: string;
}

/** A player's fantasy points (from score_entry) over some slice of fixtures. */
export interface PlayerPoints extends PlayerRef {
  /** Total fantasy points, rounded to 2dp. */
  points: number;
  /** Number of fixtures the player has a score_entry for in the slice. */
  appearances: number;
}

/** A player's total of one raw counting stat (from stat_line). */
export interface PlayerStatTotal extends PlayerRef {
  metric: StatMetric;
  total: number;
}

/** Raw counting stats we expose leaders for. */
export type StatMetric = "goals" | "assists" | "saves" | "minutesPlayed";

const METRIC_COLUMN = {
  goals: statLine.goals,
  assists: statLine.assists,
  saves: statLine.saves,
  minutesPlayed: statLine.minutesPlayed,
} as const;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Load player refs (with national-team name) for a set of player ids. */
async function loadRefs(
  db: Db | DbTx,
  playerIds: number[],
): Promise<Map<number, PlayerRef>> {
  const refs = new Map<number, PlayerRef>();
  if (playerIds.length === 0) return refs;
  const players = await db
    .select()
    .from(player)
    .where(inArray(player.id, playerIds));
  const teamIds = Array.from(new Set(players.map((p) => p.nationalTeamId)));
  const teams =
    teamIds.length > 0
      ? await db
          .select()
          .from(nationalTeam)
          .where(inArray(nationalTeam.id, teamIds))
      : [];
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  for (const p of players) {
    refs.set(p.id, {
      playerId: p.id,
      fullName: p.fullName,
      position: p.position,
      nationalTeamId: p.nationalTeamId,
      nationalTeamName: teamName.get(p.nationalTeamId) ?? "",
    });
  }
  return refs;
}

/** The fixture ids belonging to a stage (or all fixtures when stage is omitted). */
async function fixtureIdsForStage(
  db: Db | DbTx,
  stage?: Stage,
): Promise<number[] | null> {
  if (stage === undefined) return null; // null = "all fixtures"
  const rows = await db
    .select({ id: fixture.id })
    .from(fixture)
    .where(eq(fixture.stage, stage));
  return rows.map((r) => r.id);
}

export interface TopScorersQuery {
  /** Which scoring ruleset's points to total (league.scoringRuleset.version). */
  rulesetVersion: string;
  /** Restrict to one stage's fixtures; omit for the whole tournament. */
  stage?: Stage;
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
