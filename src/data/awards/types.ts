/**
 * Public types for the tournament awards registry (Phase 7.1).
 *
 * Split out of registry.ts (tech-debt #3). registry.ts re-exports every name
 * here, so consumer import paths are unchanged.
 */
import type { Db } from "../db/client.js";
import type { StandingsEntry, XiSlot } from "../standings/standings.js";

// --- Public types ------------------------------------------------------------

export type AwardScope = "league" | "global";

/** One ranked row of an award's leaderboard. Flat + JSON-serializable. */
export interface AwardEntry {
  /** 1-based; rows with an equal headline value share a rank. */
  rank: number;
  /** The headline number this award ranks by (rounded to 2dp). */
  value: number;
  /** Primary label: a fantasy team name (league scope) or player name (global). */
  title: string;
  /** Secondary line: manager, nation, opponent/stage, or "" when not applicable. */
  subtitle: string;
  /** The fantasy team this row is attributed to, or null (global player awards). */
  fantasyTeamId: number | null;
  /** The manager this row is attributed to, or null. */
  managerId: number | null;
  /** The underlying player, when the row is about a single player, else null. */
  playerId: number | null;
  /** Best-ball XI for the "best single XI" award; omitted otherwise. */
  lineup?: XiSlot[];
}

/** Context handed to every award's `compute`. */
export interface AwardContext {
  db: Db;
  /** Ruleset version to score against (caller-derived; never hard-coded). */
  rulesetVersion: string;
  /** Required for league-scope awards; ignored by global ones. */
  leagueId?: number;
  /** Cap each leaderboard. Defaults to 10. */
  limit?: number;
  /**
   * Optional pre-computed standings (a perf hint shared by the manager awards
   * so the Trophy Room computes the ladder once). Awards fall back to
   * `computeStandings` when absent, so each stays independently runnable.
   */
  standings?: readonly StandingsEntry[];
}

/** A registry award: an id, a label, and a pure ranked-list `compute`. */
export interface AwardDefinition {
  id: string;
  label: string;
  scope: AwardScope;
  /** One-line human description of what the award measures. */
  description: string;
  /** Unit/explanation for `value`, e.g. "goals", "pts", "saves", "variance". */
  unit: string;
  compute(ctx: AwardContext): Promise<AwardEntry[]>;
}

/** An award plus its computed leaderboard. */
export interface AwardResult {
  id: string;
  label: string;
  scope: AwardScope;
  description: string;
  unit: string;
  entries: AwardEntry[];
}

// --- Query types -------------------------------------------------------------

export interface TrophyRoomQuery {
  leagueId: number;
  /** The league's OWN ruleset version (league.scoringRuleset.version). */
  rulesetVersion: string;
  limit?: number;
}

export interface GlobalAwardsQuery {
  /** HUB_RULESET_VERSION at the call site. */
  rulesetVersion: string;
  limit?: number;
}
