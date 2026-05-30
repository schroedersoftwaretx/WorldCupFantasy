/**
 * Compute each player's contribution share relative to their national team
 * based on accumulated stat_line records from finished fixtures.
 *
 * These shares feed into the projection model. When a player has no stat
 * history yet (e.g. pre-tournament), we fall back to position-based priors
 * so every player still gets a non-zero projection.
 */

import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type { Position } from "../db/schema.js";
import * as schema from "../db/schema.js";

export interface PlayerShares {
  playerId: number;
  teamId: number;
  position: Position;
  /**
   * Fraction of team's total goals this player scored (0-1).
   * Falls back to position prior when no history.
   */
  goalShare: number;
  /**
   * Fraction of team's total goals this player assisted (0-1).
   * Falls back to position prior.
   */
  assistShare: number;
  /**
   * Fraction of maximum possible minutes played (0-1).
   * Used as a proxy for appearance probability.
   */
  minutesShare: number;
  /** Number of finished fixtures contributing to this player's stats. */
  fixtureCount: number;
}

/**
 * Position-based priors: expected share of team goals/assists for a player
 * at each position if we have no historical data. These are calibrated for
 * a squad of ~23 players where each position group has varying squad depth.
 */
const GOAL_SHARE_PRIOR: Record<Position, number> = {
  GK: 0.001,
  DEF: 0.04,
  MID: 0.09,
  FWD: 0.18,
};

const ASSIST_SHARE_PRIOR: Record<Position, number> = {
  GK: 0.001,
  DEF: 0.05,
  MID: 0.12,
  FWD: 0.10,
};

/** Expected minutes fraction for a typical starter vs squad player. */
const MINUTES_SHARE_PRIOR: Record<Position, number> = {
  GK: 0.45, // one of two GKs typically plays
  DEF: 0.40,
  MID: 0.35,
  FWD: 0.30,
};

// 90 min regulation × 3 group games as the "maximum possible" reference
const MINUTES_PER_GAME = 90;

export interface PlayerSharesMap {
  /** Keyed by playerId. */
  byPlayer: Map<number, PlayerShares>;
  /**
   * Total goals scored per teamId across all finished fixtures.
   * Used by the projection engine to estimate future scoring.
   */
  teamGoals: Map<number, number>;
}

/**
 * Compute player shares from all stat_lines in the database.
 * This is a full scan — should be fast enough for tournament-scale data (~700 players × ~6 games).
 */
export async function computePlayerShares(
  db: NodePgDatabase<typeof schema>,
): Promise<PlayerSharesMap> {
  // Pull every stat_line joined with player info.
  const rows = await db
    .select({
      playerId: schema.statLine.playerId,
      teamId: schema.player.nationalTeamId,
      position: schema.player.position,
      minutesPlayed: schema.statLine.minutesPlayed,
      goals: schema.statLine.goals,
      assists: schema.statLine.assists,
    })
    .from(schema.statLine)
    .innerJoin(schema.player, eq(schema.statLine.playerId, schema.player.id));

  // Accumulate per-player totals.
  type Acc = {
    teamId: number;
    position: Position;
    totalMinutes: number;
    totalGoals: number;
    totalAssists: number;
    fixtureCount: number;
  };
  const playerAcc = new Map<number, Acc>();
  // Accumulate per-team totals (for normalization).
  const teamGoalTotal = new Map<number, number>();
  const teamAssistTotal = new Map<number, number>();
  const teamMaxMinutes = new Map<number, number>(); // max minutes any player played per team (proxy for games played)

  for (const row of rows) {
    let acc = playerAcc.get(row.playerId);
    if (!acc) {
      acc = {
        teamId: row.teamId,
        position: row.position,
        totalMinutes: 0,
        totalGoals: 0,
        totalAssists: 0,
        fixtureCount: 0,
      };
      playerAcc.set(row.playerId, acc);
    }
    acc.totalMinutes += row.minutesPlayed;
    acc.totalGoals += row.goals;
    acc.totalAssists += row.assists;
    acc.fixtureCount += 1;

    teamGoalTotal.set(row.teamId, (teamGoalTotal.get(row.teamId) ?? 0) + row.goals);
    teamAssistTotal.set(row.teamId, (teamAssistTotal.get(row.teamId) ?? 0) + row.assists);
    teamMaxMinutes.set(
      row.teamId,
      Math.max(teamMaxMinutes.get(row.teamId) ?? 0, acc.totalMinutes),
    );
  }

  // Fetch all players (even those with no stat_lines yet) so everyone gets a projection.
  const allPlayers = await db
    .select({
      id: schema.player.id,
      teamId: schema.player.nationalTeamId,
      position: schema.player.position,
    })
    .from(schema.player)
    .where(eq(schema.player.status, "ACTIVE"));

  const byPlayer = new Map<number, PlayerShares>();

  for (const p of allPlayers) {
    const acc = playerAcc.get(p.id);
    const teamGoals = teamGoalTotal.get(p.teamId) ?? 0;
    const teamAssists = teamAssistTotal.get(p.teamId) ?? 0;
    const teamMax = teamMaxMinutes.get(p.teamId) ?? 0;

    if (!acc || acc.fixtureCount === 0) {
      // No history — use priors.
      byPlayer.set(p.id, {
        playerId: p.id,
        teamId: p.teamId,
        position: p.position,
        goalShare: GOAL_SHARE_PRIOR[p.position],
        assistShare: ASSIST_SHARE_PRIOR[p.position],
        minutesShare: MINUTES_SHARE_PRIOR[p.position],
        fixtureCount: 0,
      });
    } else {
      // Blend observed share with prior (Bayesian-ish smoothing).
      // Weight: 3 games of prior vs actual game count.
      const priorWeight = 3;
      const totalWeight = priorWeight + acc.fixtureCount;

      const obsGoalShare = teamGoals > 0 ? acc.totalGoals / teamGoals : 0;
      const obsAssistShare = teamAssists > 0 ? acc.totalAssists / teamAssists : 0;
      const obsMinutesShare =
        teamMax > 0
          ? acc.totalMinutes / (MINUTES_PER_GAME * acc.fixtureCount)
          : MINUTES_SHARE_PRIOR[p.position];

      byPlayer.set(p.id, {
        playerId: p.id,
        teamId: p.teamId,
        position: p.position,
        goalShare:
          (GOAL_SHARE_PRIOR[p.position] * priorWeight + obsGoalShare * acc.fixtureCount) /
          totalWeight,
        assistShare:
          (ASSIST_SHARE_PRIOR[p.position] * priorWeight + obsAssistShare * acc.fixtureCount) /
          totalWeight,
        minutesShare: Math.min(
          1,
          (MINUTES_SHARE_PRIOR[p.position] * priorWeight + obsMinutesShare * acc.fixtureCount) /
            totalWeight,
        ),
        fixtureCount: acc.fixtureCount,
      });
    }
  }

  return { byPlayer, teamGoals: teamGoalTotal };
}
