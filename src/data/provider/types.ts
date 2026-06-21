/**
 * Provider boundary types.
 *
 * Everything downstream of the provider — ingestion, the eventual scoring
 * engine, the app, the UI — depends only on these types. Vendor-specific
 * payload shapes (api-sports.io's `response` envelopes, their nested
 * `statistics[0]` arrays, etc.) must not leak past this boundary.
 *
 * When a new data source needs to be supported, implement `StatsProvider`
 * with whatever client/SDK it requires; nothing else in the codebase should
 * have to change.
 */

import type { Position, Stage } from "../db/schema.js";

/** Roster description for one player as the provider knows them. */
export interface ProviderPlayer {
  /** Provider's stable player id. Treated as opaque text. */
  sourcePlayerId: string;
  fullName: string;
  position: Position;
  /** Provider's stable national-team id this player belongs to. */
  sourceTeamId: string;
}

/** National team metadata returned alongside squads. */
export interface ProviderNationalTeam {
  sourceTeamId: string;
  name: string;
  /** Group label, e.g. "A".."L". Null if the provider hasn't seeded groups yet. */
  groupLabel: string | null;
}

/** Squad result: a team and its players. */
export interface ProviderSquad {
  team: ProviderNationalTeam;
  players: ProviderPlayer[];
}

/** Fixture metadata. */
export interface ProviderFixture {
  sourceFixtureId: string;
  stage: Stage;
  sourceHomeTeamId: string;
  sourceAwayTeamId: string;
  /** Kickoff timestamp in UTC. */
  kickoffUtc: Date;
  status: "SCHEDULED" | "LIVE" | "FINISHED";
  /** Final regulation + ET score. Null until the match is FINISHED. */
  homeScore: number | null;
  awayScore: number | null;
}

/**
 * Raw per-player statistics for one fixture.
 *
 * Field semantics MUST match the spec exactly. In particular:
 *  - `teamConcededInRegulationAndEt` excludes penalty-shootout goals.
 *  - `goals` excludes penalty-shootout goals (those are not official goals).
 *  - Extra-time stats DO count toward all event totals.
 */
export interface ProviderStatLine {
  sourceFixtureId: string;
  sourcePlayerId: string;
  minutesPlayed: number;
  goals: number;
  assists: number;
  saves: number;
  yellowCards: number;
  redCards: number;
  penaltiesScored: number;
  penaltiesMissed: number;
  penaltiesSaved: number;
  ownGoals: number;
  teamConcededInRegulationAndEt: number;
  /** Goals the player's team SCORED in regulation + ET (excludes shootout). */
  teamScoredInRegulationAndEt: number;
  // --- Detailed-action counts (v2). 0 when the provider can't supply them. ---
  shotsOnTarget: number;
  shotsOffTarget: number;
  tacklesSuccessful: number;
  crosses: number;
  passesCompleted: number;
  /** Playmaking: key passes (a pass leading to a shot). 0 when unavailable. */
  keyPasses: number;
  /** Playmaking: big chances created. 0 when unavailable. */
  bigChancesCreated: number;
  /** Goals conceded attributable to this player as keeper. */
  goalsConceded: number;
  /**
   * Provider's revision/version marker for this stat row. Free-form string;
   * the ingestion path uses lexicographic comparison and upserts only when
   * the incoming revision is >= the stored one.
   */
  sourceRevision: string;
}

/**
 * Implemented by every concrete data source. The two implementations in
 * Phase 1 are ApiFootballProvider (live) and FixtureMockProvider (offline).
 */
export interface StatsProvider {
  /** All 48 World Cup squads with their players. */
  fetchSquads(): Promise<ProviderSquad[]>;

  /** All 104 fixtures with stage, teams, kickoff (UTC), status. */
  fetchSchedule(): Promise<ProviderFixture[]>;

  /** Per-player raw stats for one finished fixture. */
  fetchFixtureStats(sourceFixtureId: string): Promise<ProviderStatLine[]>;
}

/**
 * Provider invariant violations — e.g. an unrecognised round label, a
 * malformed payload — throw this so ingestion fails loudly rather than
 * silently mis-classifying data.
 */
export class ProviderMappingError extends Error {
  public readonly providerCause?: unknown;
  constructor(message: string, providerCause?: unknown) {
    super(message);
    this.name = "ProviderMappingError";
    this.providerCause = providerCause;
  }
}
