/**
 * Team of the Matchday / Stage (Phase 1) - pure-core + db wrapper.
 *
 * The headline Stats Hub feature: the single best-scoring LEGAL starting XI
 * drawn from the GLOBAL player pool for one scoring period, not from any one
 * fantasy roster. It reuses the best-ball optimizer in
 * `src/data/standings/lineup.ts` verbatim - the only new work is loading every
 * player's stage points into the optimizer's `ScoredPlayer[]` shape.
 *
 * Read-only over the existing scoring spine: score_entry (points, keyed by
 * ruleset version) and stat_line (the key raw stats shown alongside each pick).
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
import {
  LEGAL_FORMATIONS,
  formationLabel,
  optimizeBestBall,
  type BestBallResult,
  type ScoredPlayer,
} from "../standings/lineup.js";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** One pick in the Team of the Stage, with the key raw stats for display. */
export interface TeamOfStagePlayer {
  playerId: number;
  fullName: string;
  position: Position;
  nationalTeamId: number;
  nationalTeamName: string;
  /** Fantasy points the player scored in this stage, 2dp. */
  points: number;
  /** Key raw stats over the stage (from stat_line). */
  goals: number;
  assists: number;
  saves: number;
  minutesPlayed: number;
}

export interface TeamOfStage {
  stage: Stage;
  /** Conventional formation label, e.g. "4-3-3"; null when no legal XI yet. */
  formation: string | null;
  /** Sum of the XI's points, 2dp. */
  points: number;
  xi: TeamOfStagePlayer[];
}

/**
 * Can `pool` field ANY of the four legal formations? The optimizer throws on a
 * pool that can fill none (too few of some position); this guard lets the
 * caller return an empty result early (e.g. a stage with sparse data).
 */
export function canFieldAnyFormation(pool: readonly ScoredPlayer[]): boolean {
  const c: Record<Position, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const p of pool) c[p.position] += 1;
  return LEGAL_FORMATIONS.some(
    (f) => c.GK >= f.GK && c.DEF >= f.DEF && c.MID >= f.MID && c.FWD >= f.FWD,
  );
}

/**
 * Pure core: the best legal XI from an arbitrary scored player pool, or null
 * when the pool cannot field any legal formation. Exported so the optimizer
 * boundary can be unit-tested without a database.
 */
export function optimizeGlobalXi(
  pool: readonly ScoredPlayer[],
): BestBallResult | null {
  if (!canFieldAnyFormation(pool)) return null;
  return optimizeBestBall(pool);
}

export interface TeamOfStageQuery {
  /** Which scoring ruleset's points to optimize over. */
  rulesetVersion: string;
  stage: Stage;
}

/**
 * The Team of the Stage: load every player's total points across the stage's
 * fixtures, run the best-ball optimizer over the whole pool, and decorate the
 * winning XI with names + key raw stats. Pure read - makes no writes.
 */
export async function teamOfTheStage(
  db: Db | DbTx,
  query: TeamOfStageQuery,
): Promise<TeamOfStage> {
  const empty: TeamOfStage = {
    stage: query.stage,
    formation: null,
    points: 0,
    xi: [],
  };

  const fxRows = await db
    .select({ id: fixture.id })
    .from(fixture)
    .where(eq(fixture.stage, query.stage));
  const fxIds = fxRows.map((r) => r.id);
  if (fxIds.length === 0) return empty;

  const scores = await db
    .select()
    .from(scoreEntry)
    .where(
      and(
        eq(scoreEntry.rulesetVersion, query.rulesetVersion),
        inArray(scoreEntry.fixtureId, fxIds),
      ),
    );
  if (scores.length === 0) return empty;

  // Sum each player's points across the stage's fixtures.
  const pts = new Map<number, number>();
  for (const s of scores) pts.set(s.playerId, (pts.get(s.playerId) ?? 0) + s.points);

  const playerIds = Array.from(pts.keys());
  const players = await db
    .select()
    .from(player)
    .where(inArray(player.id, playerIds));
  const playerById = new Map(players.map((p) => [p.id, p]));

  const pool: ScoredPlayer[] = [];
  for (const [pid, points] of pts) {
    const p = playerById.get(pid);
    if (!p) continue;
    pool.push({ playerId: pid, position: p.position, points });
  }

  const best = optimizeGlobalXi(pool);
  if (!best) return empty;

  const xiIds = best.xi.map((x) => x.playerId);
  const xiIdSet = new Set(xiIds);
  const stats = await db
    .select()
    .from(statLine)
    .where(
      and(inArray(statLine.playerId, xiIds), inArray(statLine.fixtureId, fxIds)),
    );
  const statAgg = new Map<
    number,
    { goals: number; assists: number; saves: number; minutesPlayed: number }
  >();
  for (const st of stats) {
    const a =
      statAgg.get(st.playerId) ??
      { goals: 0, assists: 0, saves: 0, minutesPlayed: 0 };
    a.goals += st.goals;
    a.assists += st.assists;
    a.saves += st.saves;
    a.minutesPlayed += st.minutesPlayed;
    statAgg.set(st.playerId, a);
  }

  const teamIds = Array.from(
    new Set(
      players.filter((p) => xiIdSet.has(p.id)).map((p) => p.nationalTeamId),
    ),
  );
  const teams =
    teamIds.length > 0
      ? await db
          .select()
          .from(nationalTeam)
          .where(inArray(nationalTeam.id, teamIds))
      : [];
  const teamName = new Map(teams.map((t) => [t.id, t.name]));

  const xi: TeamOfStagePlayer[] = best.xi.map((sp) => {
    const p = playerById.get(sp.playerId);
    const a =
      statAgg.get(sp.playerId) ??
      { goals: 0, assists: 0, saves: 0, minutesPlayed: 0 };
    return {
      playerId: sp.playerId,
      fullName: p?.fullName ?? `#${sp.playerId}`,
      position: sp.position,
      nationalTeamId: p?.nationalTeamId ?? 0,
      nationalTeamName: p ? (teamName.get(p.nationalTeamId) ?? "") : "",
      points: round2(sp.points),
      goals: a.goals,
      assists: a.assists,
      saves: a.saves,
      minutesPlayed: a.minutesPlayed,
    };
  });

  return {
    stage: query.stage,
    formation: formationLabel(best.formation),
    points: round2(best.points),
    xi,
  };
}
