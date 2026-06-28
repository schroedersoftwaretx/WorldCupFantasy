/**
 * Stage discovery and recent-form aggregation.
 *
 * Extracted from aggregate.ts (tech-debt #3). Behavior-preserving: identical SQL
 * and in-memory aggregation. Re-exported via the aggregate.ts barrel.
 */
import { eq, inArray } from "drizzle-orm";

import type { Db, DbTx } from "../db/client.js";
import { fixture, scoreEntry, type Position, type Stage } from "../db/schema.js";
import { STAGE_ORDER, loadRefs, round2, type PlayerRef } from "./refs.js";

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
