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
  stageEnum,
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

// --- Phase 1: stage discovery -------------------------------------------------

/** The nine scoring periods in tournament order. */
export const STAGE_ORDER: readonly Stage[] = stageEnum.enumValues;
/** Position display/sort order: keeper first, then back-to-front. */
export const POSITION_ORDER: readonly Position[] = ["GK", "DEF", "MID", "FWD"];

/**
 * The stages (in tournament order) that have at least one score_entry for the
 * given ruleset. Used to pick a sensible default stage for the Stats Hub and to
 * decide which stages to surface.
 */
export async function stagesWithScores(
  db: Db | DbTx,
  rulesetVersion: string,
): Promise<Stage[]> {
  const scores = await db
    .select({ fixtureId: scoreEntry.fixtureId })
    .from(scoreEntry)
    .where(eq(scoreEntry.rulesetVersion, rulesetVersion));
  if (scores.length === 0) return [];
  const fxIds = Array.from(new Set(scores.map((s) => s.fixtureId)));
  const fixtures = await db
    .select({ id: fixture.id, stage: fixture.stage })
    .from(fixture)
    .where(inArray(fixture.id, fxIds));
  const present = new Set(fixtures.map((f) => f.stage));
  return STAGE_ORDER.filter((s) => present.has(s));
}

/** The most recent stage with any score_entry for the ruleset, or null. */
export async function latestStageWithScores(
  db: Db | DbTx,
  rulesetVersion: string,
): Promise<Stage | null> {
  const stages = await stagesWithScores(db, rulesetVersion);
  return stages.length > 0 ? (stages[stages.length - 1] ?? null) : null;
}

// --- Phase 1: form ------------------------------------------------------------

export interface PlayerFormQuery {
  rulesetVersion: string;
  /** Number of the player's most-recent featured fixtures to total. Default 3. */
  lastN?: number;
  /** Restrict to one position; omit for all positions. */
  position?: Position;
  /** Cap the result list. Default 20. */
  limit?: number;
}

/** Points over the last N fixtures a player featured in (had a score_entry for). */
export interface PlayerForm extends PlayerRef {
  /** Total fantasy points over the last N featured fixtures, 2dp. */
  points: number;
  /** Number of fixtures counted (<= lastN). */
  appearances: number;
}

/**
 * "Form": each player's fantasy points over the most recent `lastN` fixtures
 * they actually featured in (ordered by kickoff). Sorted by those points desc.
 */
export async function playerForm(
  db: Db | DbTx,
  query: PlayerFormQuery,
): Promise<PlayerForm[]> {
  const lastN = query.lastN ?? 3;
  const limit = query.limit ?? 20;
  const scores = await db
    .select()
    .from(scoreEntry)
    .where(eq(scoreEntry.rulesetVersion, query.rulesetVersion));
  if (scores.length === 0) return [];

  const fixtures = await db
    .select({ id: fixture.id, kickoffUtc: fixture.kickoffUtc })
    .from(fixture);
  const kickoffById = new Map(fixtures.map((f) => [f.id, f.kickoffUtc]));

  const byPlayer = new Map<
    number,
    { fixtureId: number; points: number; kickoff: number }[]
  >();
  for (const s of scores) {
    const ko = kickoffById.get(s.fixtureId);
    if (!ko) continue;
    const arr = byPlayer.get(s.playerId) ?? [];
    arr.push({ fixtureId: s.fixtureId, points: s.points, kickoff: ko.getTime() });
    byPlayer.set(s.playerId, arr);
  }

  const refs = await loadRefs(db, Array.from(byPlayer.keys()));
  const out: PlayerForm[] = [];
  for (const [playerId, entries] of byPlayer) {
    const ref = refs.get(playerId);
    if (!ref) continue;
    if (query.position && ref.position !== query.position) continue;
    entries.sort((a, b) => b.kickoff - a.kickoff || b.fixtureId - a.fixtureId);
    const recent = entries.slice(0, lastN);
    const points = recent.reduce((sum, e) => sum + e.points, 0);
    out.push({ ...ref, points: round2(points), appearances: recent.length });
  }
  out.sort(
    (a, b) =>
      b.points - a.points ||
      b.appearances - a.appearances ||
      a.playerId - b.playerId,
  );
  return out.slice(0, limit);
}

// --- Phase 1: best single-match hauls (also feeds Phase 7 awards) ------------

export interface MatchHaulQuery {
  rulesetVersion: string;
  /** Restrict to one stage's fixtures; omit for the whole tournament. */
  stage?: Stage;
  /** Cap the result list. Default 10. */
  limit?: number;
}

/** One player's points in a single fixture, the biggest individual returns. */
export interface MatchHaul extends PlayerRef {
  /** Fantasy points in that single fixture, 2dp. */
  points: number;
  fixtureId: number;
  stage: Stage;
  /** The opponent national team in that fixture, when derivable. */
  opponentTeamId: number | null;
  opponentTeamName: string;
}

/**
 * Highest single-match fantasy hauls (one score_entry row = one player in one
 * fixture), ruleset-scoped, optionally within a stage. Sorted by points desc,
 * then playerId asc, then fixtureId asc. Phase 7 awards reuse this query.
 */
export async function bestSingleMatchHauls(
  db: Db | DbTx,
  query: MatchHaulQuery,
): Promise<MatchHaul[]> {
  const limit = query.limit ?? 10;
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
  if (scores.length === 0) return [];
  scores.sort(
    (a, b) =>
      b.points - a.points || a.playerId - b.playerId || a.fixtureId - b.fixtureId,
  );
  const top = scores.slice(0, limit);

  const refs = await loadRefs(db, top.map((s) => s.playerId));
  const fxIds = Array.from(new Set(top.map((s) => s.fixtureId)));
  const fixtures = await db
    .select()
    .from(fixture)
    .where(inArray(fixture.id, fxIds));
  const fxById = new Map(fixtures.map((f) => [f.id, f]));
  const teamIds = new Set<number>();
  for (const f of fixtures) {
    teamIds.add(f.homeTeamId);
    teamIds.add(f.awayTeamId);
  }
  const teams =
    teamIds.size > 0
      ? await db
          .select()
          .from(nationalTeam)
          .where(inArray(nationalTeam.id, Array.from(teamIds)))
      : [];
  const teamName = new Map(teams.map((t) => [t.id, t.name]));

  const out: MatchHaul[] = [];
  for (const s of top) {
    const ref = refs.get(s.playerId);
    const fx = fxById.get(s.fixtureId);
    if (!ref || !fx) continue;
    let opponentTeamId: number | null = null;
    if (fx.homeTeamId === ref.nationalTeamId) opponentTeamId = fx.awayTeamId;
    else if (fx.awayTeamId === ref.nationalTeamId) opponentTeamId = fx.homeTeamId;
    out.push({
      ...ref,
      points: round2(s.points),
      fixtureId: s.fixtureId,
      stage: fx.stage,
      opponentTeamId,
      opponentTeamName:
        opponentTeamId !== null ? (teamName.get(opponentTeamId) ?? "") : "",
    });
  }
  return out;
}

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
