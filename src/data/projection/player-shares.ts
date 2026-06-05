/**
 * Compute each player's contribution share relative to their national team
 * based on accumulated stat_line records from finished fixtures.
 *
 * ## Prior model (pre-tournament / early tournament)
 *
 * When little or no stat_line data exists we fall back to a rank-weighted
 * prior instead of a flat position prior.  The key insight: `player.draft_rank`
 * tells us a lot about who is likely to start.  Rank 1 on a team is almost
 * certainly the starting striker/GK/etc; rank 22 is a squad depth player.
 *
 * We derive a `starterProbability` (roughly expected minutes fraction) per
 * player by ranking them within their {team x position} group and mapping
 * that ordinal rank to a known playing-time curve for each position.
 *
 * Goal/assist shares are then scaled proportionally to starterProbability:
 *   goalShare = GOAL_RATE_STARTER[position] * (starterProbability / FULL_STARTER_MINS)
 *
 * ## In-tournament update
 *
 * Once stat_lines accumulate we blend observed shares with the prior using a
 * Bayesian-style weight (3 prior games vs actual game count).
 * A player who outperforms their pre-tournament rank will see their projection
 * update accordingly within a game or two.
 */

import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type { Position } from "../db/schema.js";
import * as schema from "../db/schema.js";

// ---------------------------------------------------------------------------
// Starter probability curves
// ---------------------------------------------------------------------------

/**
 * For each position, expected minutes fraction (0-1) for the Nth-ranked
 * player at that position on a 26-man squad.
 * Index 0 = 1st-ranked, index 1 = 2nd-ranked, etc.
 * Values past the array length use the last entry.
 */
const STARTER_CURVE: Record<Position, number[]> = {
  // One starting GK plays ~88% of minutes; backup ~8%; third-choice ~2%.
  GK:  [0.88, 0.08, 0.02],
  // Back four: top 4 likely starters; 5th regular rotator; 6th+ depth.
  DEF: [0.82, 0.80, 0.78, 0.76, 0.35, 0.10, 0.04],
  // Four midfielders start; 5th-6th rotate; rest are depth.
  MID: [0.78, 0.76, 0.74, 0.72, 0.32, 0.28, 0.08, 0.04],
  // Two or three forwards start; 4th is regular impact sub; 5th+ depth.
  FWD: [0.78, 0.76, 0.72, 0.32, 0.10, 0.04],
};

/**
 * Goal and assist rates for a full-time starter (minutesShare ~0.9) at
 * each position. Represents fraction of team goals/assists per game.
 */
const GOAL_RATE_STARTER: Record<Position, number> = {
  GK:  0.001,
  DEF: 0.045,
  MID: 0.100,
  FWD: 0.200,
};

const ASSIST_RATE_STARTER: Record<Position, number> = {
  GK:  0.001,
  DEF: 0.055,
  MID: 0.130,
  FWD: 0.110,
};

/** Minutes fraction treated as "full-time starter" for rate scaling. */
const FULL_STARTER_MINS = 0.90;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PlayerShares {
  playerId: number;
  teamId: number;
  position: Position;
  goalShare: number;
  assistShare: number;
  minutesShare: number;
  fixtureCount: number;
}

export interface PlayerSharesMap {
  byPlayer: Map<number, PlayerShares>;
  teamGoals: Map<number, number>;
}

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

export async function computePlayerShares(
  db: NodePgDatabase<typeof schema>,
): Promise<PlayerSharesMap> {

  // Load all active players with draftRank.
  const allPlayers = await db
    .select({
      id: schema.player.id,
      teamId: schema.player.nationalTeamId,
      position: schema.player.position,
      draftRank: schema.player.draftRank,
    })
    .from(schema.player)
    .where(eq(schema.player.status, "ACTIVE"));

  // Group players by {teamId:position}, sort by draftRank (nulls last).
  type PlayerMeta = (typeof allPlayers)[number];
  const groups = new Map<string, PlayerMeta[]>();
  for (const p of allPlayers) {
    const key = `${p.teamId}:${p.position}`;
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => {
      if (a.draftRank === null && b.draftRank === null) return a.id - b.id;
      if (a.draftRank === null) return 1;
      if (b.draftRank === null) return -1;
      return a.draftRank - b.draftRank;
    });
  }

  // Build rank-weighted prior for each player.
  const priorByPlayer = new Map<number, PlayerShares>();
  for (const [, list] of groups) {
    for (let i = 0; i < list.length; i++) {
      const p = list[i]!;
      const curve = STARTER_CURVE[p.position];
      const minutesShare = curve[Math.min(i, curve.length - 1)]!;
      const scale = minutesShare / FULL_STARTER_MINS;
      priorByPlayer.set(p.id, {
        playerId: p.id,
        teamId: p.teamId,
        position: p.position,
        goalShare: GOAL_RATE_STARTER[p.position] * scale,
        assistShare: ASSIST_RATE_STARTER[p.position] * scale,
        minutesShare,
        fixtureCount: 0,
      });
    }
  }

  // Load observed stat_lines.
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

  if (rows.length === 0) {
    return { byPlayer: priorByPlayer, teamGoals: new Map() };
  }

  type Acc = { totalMinutes: number; totalGoals: number; totalAssists: number; fixtureCount: number };
  const playerAcc = new Map<number, Acc>();
  const teamGoalTotal = new Map<number, number>();
  const teamAssistTotal = new Map<number, number>();

  for (const row of rows) {
    let acc = playerAcc.get(row.playerId);
    if (!acc) {
      acc = { totalMinutes: 0, totalGoals: 0, totalAssists: 0, fixtureCount: 0 };
      playerAcc.set(row.playerId, acc);
    }
    acc.totalMinutes += row.minutesPlayed;
    acc.totalGoals += row.goals;
    acc.totalAssists += row.assists;
    acc.fixtureCount += 1;
    teamGoalTotal.set(row.teamId, (teamGoalTotal.get(row.teamId) ?? 0) + row.goals);
    teamAssistTotal.set(row.teamId, (teamAssistTotal.get(row.teamId) ?? 0) + row.assists);
  }

  const PRIOR_WEIGHT = 3;
  const byPlayer = new Map<number, PlayerShares>();

  for (const p of allPlayers) {
    const prior = priorByPlayer.get(p.id)!;
    const acc = playerAcc.get(p.id);

    if (!acc || acc.fixtureCount === 0) {
      byPlayer.set(p.id, prior);
      continue;
    }

    const teamGoals   = teamGoalTotal.get(p.teamId) ?? 0;
    const teamAssists = teamAssistTotal.get(p.teamId) ?? 0;
    const w           = PRIOR_WEIGHT + acc.fixtureCount;

    const obsGoalShare   = teamGoals   > 0 ? acc.totalGoals   / teamGoals   : 0;
    const obsAssistShare = teamAssists > 0 ? acc.totalAssists / teamAssists : 0;
    const obsMinsFrac    = Math.min(1, acc.totalMinutes / (90 * acc.fixtureCount));

    byPlayer.set(p.id, {
      playerId: p.id,
      teamId: p.teamId,
      position: p.position,
      goalShare:    (prior.goalShare    * PRIOR_WEIGHT + obsGoalShare   * acc.fixtureCount) / w,
      assistShare:  (prior.assistShare  * PRIOR_WEIGHT + obsAssistShare * acc.fixtureCount) / w,
      minutesShare: Math.min(1, (prior.minutesShare * PRIOR_WEIGHT + obsMinsFrac * acc.fixtureCount) / w),
      fixtureCount: acc.fixtureCount,
    });
  }

  return { byPlayer, teamGoals: teamGoalTotal };
}
