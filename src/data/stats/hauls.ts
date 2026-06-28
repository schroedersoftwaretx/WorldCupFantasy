/**
 * Best single-match fantasy hauls (also feeds Phase 7 awards).
 *
 * Extracted from aggregate.ts (tech-debt #3). Behavior-preserving: identical SQL
 * and in-memory aggregation. Re-exported via the aggregate.ts barrel.
 */
import { and, eq, inArray } from "drizzle-orm";

import type { Db, DbTx } from "../db/client.js";
import { fixture, nationalTeam, scoreEntry, type Stage } from "../db/schema.js";
import { fixtureIdsForStage, loadRefs, round2, type PlayerRef } from "./refs.js";

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
