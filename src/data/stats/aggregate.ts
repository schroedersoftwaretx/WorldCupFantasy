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
 *
 * This module was split (tech-debt #3) into focused units and now serves as a
 * barrel that re-exports the public surface, so existing import paths
 * (`@/data/stats/aggregate`) are unchanged:
 *   - ./refs       shared types + loadRefs + STAGE_ORDER/POSITION_ORDER
 *   - ./scoring    topScorers, perFixturePlayerPoints, statLeaders
 *   - ./form       stagesWithScores, latestStageWithScores, playerForm
 *   - ./hauls      bestSingleMatchHauls
 *   - ./breakdowns nationStatLeaders, positionScarcity
 * The internal helpers round2, fixtureIdsForStage and METRIC_COLUMN live in
 * ./refs and are deliberately NOT re-exported here (they were never part of this
 * module's public surface).
 */

export { loadRefs, STAGE_ORDER, POSITION_ORDER } from "./refs.js";
export type {
  PlayerRef,
  PlayerPoints,
  PlayerStatTotal,
  StatMetric,
} from "./refs.js";

export { topScorers, perFixturePlayerPoints, statLeaders } from "./scoring.js";
export type { TopScorersQuery, StatLeadersQuery } from "./scoring.js";

export { stagesWithScores, latestStageWithScores, playerForm } from "./form.js";
export type { PlayerFormQuery, PlayerForm } from "./form.js";

export { bestSingleMatchHauls } from "./hauls.js";
export type { MatchHaulQuery, MatchHaul } from "./hauls.js";

export { nationStatLeaders, positionScarcity } from "./breakdowns.js";
export type { NationStatTotal, PositionStageAvg } from "./breakdowns.js";
