/**
 * Tournament awards registry (Phase 7.1 - DERIVED awards only).
 *
 * A registry of awards computed purely from already-stored data (score_entry,
 * stat_line, roster_slot, fantasy_team, standings) - it never writes and adds
 * no migration. Every award is recomputable on demand and spec-verified
 * against hand-computed expectations.
 *
 * Two scopes:
 *   - "league"  awards rank the fantasy teams WITHIN one league (the Trophy
 *               Room). Player awards (Golden Boot etc.) are attributed to the
 *               manager who rosters the scoring players.
 *   - "global"  awards are tournament-wide and player-attributed (the Stats
 *               Hub awards section), scored against HUB_RULESET_VERSION.
 *
 * Ruleset version is ALWAYS supplied by the caller (never hard-coded here):
 *   - the per-league Trophy Room passes the league's OWN
 *     `league.scoringRuleset.version` so award points match what that league
 *     sees on its standings/roster surfaces;
 *   - the global Stats Hub passes HUB_RULESET_VERSION.
 *
 * Style mirrors the stats aggregate / standings services: a few bulk queries
 * load everything, then all ranking is in-memory and pure.
 */
import type { Db } from "../db/client.js";
import { computeStandings } from "../standings/standings.js";
import {
  bestDifferentialHaul,
  bestDraftValue,
  bestHaulPerTeam,
  bestSingleXi,
  goldenBoot,
  goldenGlove,
  highestSingleStage,
  mostConsistent,
  playmaker,
} from "./league-awards.js";
import {
  globalBestHaul,
  globalGoldenBoot,
  globalGoldenGlove,
  globalPlaymaker,
} from "./global-awards.js";
import type {
  AwardContext,
  AwardDefinition,
  AwardEntry,
  AwardResult,
  AwardScope,
  GlobalAwardsQuery,
  TrophyRoomQuery,
} from "./types.js";

// Re-export the public types so existing import paths
// ("@/data/awards/registry") keep working unchanged.
export type {
  AwardContext,
  AwardDefinition,
  AwardEntry,
  AwardResult,
  AwardScope,
  GlobalAwardsQuery,
  TrophyRoomQuery,
};

// --- Registries + runners ----------------------------------------------------

/** Every league-scoped award, in Trophy Room display order. */
export const LEAGUE_AWARDS: readonly AwardDefinition[] = [
  goldenBoot,
  playmaker,
  goldenGlove,
  bestHaulPerTeam,
  highestSingleStage,
  bestSingleXi,
  bestDraftValue,
  bestDifferentialHaul,
  mostConsistent,
];

/** Every global (player-attributed) award, in Stats Hub display order. */
export const GLOBAL_AWARDS: readonly AwardDefinition[] = [
  globalGoldenBoot,
  globalPlaymaker,
  globalGoldenGlove,
  globalBestHaul,
];

/** All awards, both scopes. */
export const AWARDS: readonly AwardDefinition[] = [
  ...LEAGUE_AWARDS,
  ...GLOBAL_AWARDS,
];

async function computeAll(
  defs: readonly AwardDefinition[],
  ctx: AwardContext,
): Promise<AwardResult[]> {
  const results: AwardResult[] = [];
  for (const def of defs) {
    const entries = await def.compute(ctx);
    results.push({
      id: def.id,
      label: def.label,
      scope: def.scope,
      description: def.description,
      unit: def.unit,
      entries,
    });
  }
  return results;
}

/**
 * Compute every league award for one league's Trophy Room. The standings
 * ladder is computed once and shared across the manager awards.
 */
export async function computeTrophyRoom(
  db: Db,
  query: TrophyRoomQuery,
): Promise<AwardResult[]> {
  const standings = await computeStandings(db, query.leagueId);
  return computeAll(LEAGUE_AWARDS, {
    db,
    leagueId: query.leagueId,
    rulesetVersion: query.rulesetVersion,
    limit: query.limit ?? 25,
    standings,
  });
}

/** Compute every global (player-attributed) award for the Stats Hub. */
export async function computeGlobalAwards(
  db: Db,
  query: GlobalAwardsQuery,
): Promise<AwardResult[]> {
  return computeAll(GLOBAL_AWARDS, {
    db,
    rulesetVersion: query.rulesetVersion,
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
  });
}
