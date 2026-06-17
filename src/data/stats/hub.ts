/**
 * Stats Hub composition layer (Phase 1).
 *
 * Thin, db-first aggregators that compose the pure query primitives in
 * `aggregate.ts` and `team-of-the-stage.ts` into the two payloads the public
 * Stats Hub routes/pages render: the leaderboards bundle and the records
 * bundle. Kept here (not in the route handlers) so the composition is unit
 * testable and reused by both the API route and the server component.
 */
import type { Db, DbTx } from "../db/client.js";
import type { Position, Stage } from "../db/schema.js";
import {
  POSITION_ORDER,
  bestSingleMatchHauls,
  nationStatLeaders,
  playerForm,
  positionScarcity,
  stagesWithScores,
  statLeaders,
  topScorers,
  type MatchHaul,
  type NationStatTotal,
  type PlayerForm,
  type PlayerPoints,
  type PlayerStatTotal,
  type PositionStageAvg,
  type StatMetric,
} from "./aggregate.js";
import { teamOfTheStage, type TeamOfStage } from "./team-of-the-stage.js";
import { globalAdp, type PlayerAdp } from "./adp.js";
import { ownershipByPlayerId } from "./ownership.js";

/** The raw counting stats the hub surfaces leaders for. */
export const HUB_METRICS: readonly StatMetric[] = [
  "goals",
  "assists",
  "saves",
  "minutesPlayed",
];

export interface LeaderboardsQuery {
  rulesetVersion: string;
  /** Restrict every leaderboard to one stage; omit for the whole tournament. */
  stage?: Stage;
  /** Per-list cap. Default 20. */
  limit?: number;
  /** Window for the form list. Default 3. */
  formLastN?: number;
}

export interface Leaderboards {
  /** Echo of the stage scope (null = whole tournament). */
  stage: Stage | null;
  topScorers: PlayerPoints[];
  byPosition: Record<Position, PlayerPoints[]>;
  statLeaders: Record<StatMetric, PlayerStatTotal[]>;
  form: PlayerForm[];
  bestHauls: MatchHaul[];
}

/** Compose all tournament leaderboards for a (ruleset, optional stage). */
export async function getLeaderboards(
  db: Db | DbTx,
  query: LeaderboardsQuery,
): Promise<Leaderboards> {
  const { rulesetVersion, stage, limit, formLastN } = query;
  // exactOptionalPropertyTypes is on: only include optional keys when defined.
  const scope = {
    ...(stage !== undefined ? { stage } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
  const overall = await topScorers(db, { rulesetVersion, ...scope });

  const byPosition = {} as Record<Position, PlayerPoints[]>;
  for (const position of POSITION_ORDER) {
    byPosition[position] = await topScorers(db, {
      rulesetVersion,
      position,
      ...scope,
    });
  }

  const statLeadersByMetric = {} as Record<StatMetric, PlayerStatTotal[]>;
  for (const metric of HUB_METRICS) {
    statLeadersByMetric[metric] = await statLeaders(db, { metric, ...scope });
  }

  // Form is a tournament-wide recent-window metric, not stage-scoped.
  const form = await playerForm(db, {
    rulesetVersion,
    ...(formLastN !== undefined ? { lastN: formLastN } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
  const bestHauls = await bestSingleMatchHauls(db, { rulesetVersion, ...scope });

  return {
    stage: stage ?? null,
    topScorers: overall,
    byPosition,
    statLeaders: statLeadersByMetric,
    form,
    bestHauls,
  };
}

export interface RecordsQuery {
  rulesetVersion: string;
  /** Cap for the list-shaped records. Default 5. */
  limit?: number;
}

export interface TournamentRecords {
  /** The single highest-scoring Team of the Stage so far, or null. */
  highestScoringXi: TeamOfStage | null;
  /** The biggest individual single-match haul of the tournament, or null. */
  biggestHaul: MatchHaul | null;
  /** Nations whose players have scored the most goals. */
  topNationsByGoals: NationStatTotal[];
  /** Average points by (stage, position) - a scarcity heatmap. */
  positionScarcity: PositionStageAvg[];
}

/** Compose the tournament "records & fun stats" bundle. */
export async function getRecords(
  db: Db | DbTx,
  query: RecordsQuery,
): Promise<TournamentRecords> {
  const { rulesetVersion } = query;
  const limit = query.limit ?? 5;

  // Highest-scoring XI of the tournament so far = max Team of the Stage total
  // across the stages that have any scores.
  const stages = await stagesWithScores(db, rulesetVersion);
  let highestScoringXi: TeamOfStage | null = null;
  for (const stage of stages) {
    const tos = await teamOfTheStage(db, { rulesetVersion, stage });
    if (tos.xi.length === 0) continue;
    if (highestScoringXi === null || tos.points > highestScoringXi.points) {
      highestScoringXi = tos;
    }
  }

  const hauls = await bestSingleMatchHauls(db, { rulesetVersion, limit: 1 });
  const biggestHaul = hauls[0] ?? null;
  const topNationsByGoals = await nationStatLeaders(db, {
    metric: "goals",
    limit,
  });
  const scarcity = await positionScarcity(db, rulesetVersion);

  return {
    highestScoringXi,
    biggestHaul,
    topNationsByGoals,
    positionScarcity: scarcity,
  };
}

// --- Phase 2: Draft Trends (public) ------------------------------------------

/** One row of the public Draft Trends table: ADP analytics + global ownership. */
export interface DraftTrendRow extends PlayerAdp {
  /** Distinct fantasy teams (across eligible leagues) rostering the player. */
  ownedCount: number;
  /** ownedCount / totalFantasyTeams, in [0,1]. */
  ownershipPct: number;
}

export interface DraftTrends {
  /** Ownership denominator (fantasy teams in eligible leagues). */
  totalFantasyTeams: number;
  /** Take-rate denominator (drafts that have begun). */
  totalDrafts: number;
  /** One row per player drafted at least once, sorted by ADP ascending. */
  rows: DraftTrendRow[];
}

export interface DraftTrendsQuery {
  /** Scope ownership to finished-draft leagues. Default true. */
  finishedDraftsOnly?: boolean;
  /** Only consider COMPLETE drafts for ADP. Default false. */
  completedDraftsOnly?: boolean;
  /** Cap the row list. Omit for all drafted players. */
  limit?: number;
}

/**
 * Compose the public Draft Trends payload: every drafted player with their ADP
 * analytics (reach/steal vs draft_rank, take-rate) and global ownership %.
 * Filtering/sorting is done client-side on the page.
 */
export async function getDraftTrends(
  db: Db | DbTx,
  query: DraftTrendsQuery = {},
): Promise<DraftTrends> {
  const adp = await globalAdp(db, {
    ...(query.completedDraftsOnly !== undefined
      ? { completedDraftsOnly: query.completedDraftsOnly }
      : {}),
  });
  const ownership = await ownershipByPlayerId(db, {
    ...(query.finishedDraftsOnly !== undefined
      ? { finishedDraftsOnly: query.finishedDraftsOnly }
      : {}),
  });

  let rows: DraftTrendRow[] = adp.players.map((p) => {
    const own = ownership.byPlayerId.get(p.playerId);
    return {
      ...p,
      ownedCount: own?.ownedCount ?? 0,
      ownershipPct: own?.ownershipPct ?? 0,
    };
  });
  if (query.limit !== undefined) rows = rows.slice(0, query.limit);

  return {
    totalFantasyTeams: ownership.totalFantasyTeams,
    totalDrafts: adp.totalDrafts,
    rows,
  };
}
