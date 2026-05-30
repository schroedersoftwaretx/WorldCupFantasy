/**
 * Orchestrator: recompute projected_score_entry for all upcoming SCHEDULED
 * fixtures that have match_odds rows.
 *
 * Steps:
 *   1. Fetch all SCHEDULED fixtures that have odds.
 *   2. Compute player shares from accumulated stat_lines.
 *   3. For each (fixture, player-on-that-team) pair, compute projected points.
 *   4. Upsert into projected_score_entry.
 *
 * This is designed to be fully idempotent — calling it twice produces the
 * same rows.
 */

import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "../db/schema.js";
import { DEFAULT_RULESET } from "../scoring/ruleset.js";
import { computePlayerShares } from "./player-shares.js";
import { projectPoints } from "./project-points.js";

export interface ProjectionSummary {
  fixturesProcessed: number;
  playersProjected: number;
  rulesetVersion: string;
}

export async function recomputeProjections(
  db: NodePgDatabase<typeof schema>,
  ruleset = DEFAULT_RULESET,
): Promise<ProjectionSummary> {
  // 1. Find all SCHEDULED fixtures that have fresh odds.
  const scheduledWithOdds = await db
    .select({
      fixtureId: schema.fixture.id,
      homeTeamId: schema.fixture.homeTeamId,
      awayTeamId: schema.fixture.awayTeamId,
      odds: {
        fixtureId: schema.matchOdds.fixtureId,
        homeWinP: schema.matchOdds.homeWinP,
        drawP: schema.matchOdds.drawP,
        awayWinP: schema.matchOdds.awayWinP,
        expectedTotalGoals: schema.matchOdds.expectedTotalGoals,
        homeCleanSheetP: schema.matchOdds.homeCleanSheetP,
        awayCleanSheetP: schema.matchOdds.awayCleanSheetP,
        fetchedAt: schema.matchOdds.fetchedAt,
      },
    })
    .from(schema.fixture)
    .innerJoin(schema.matchOdds, eq(schema.fixture.id, schema.matchOdds.fixtureId))
    .where(eq(schema.fixture.status, "SCHEDULED"));

  if (scheduledWithOdds.length === 0) {
    return { fixturesProcessed: 0, playersProjected: 0, rulesetVersion: ruleset.version };
  }

  // 2. Compute player shares (reads all stat_lines once).
  const { byPlayer } = await computePlayerShares(db);

  // 3. For each fixture, fetch the players on both teams.
  const teamIds = [
    ...new Set(
      scheduledWithOdds.flatMap((f) => [f.homeTeamId, f.awayTeamId]),
    ),
  ];

  const teamPlayers = await db
    .select({
      id: schema.player.id,
      teamId: schema.player.nationalTeamId,
    })
    .from(schema.player)
    .where(
      and(
        inArray(schema.player.nationalTeamId, teamIds),
        eq(schema.player.status, "ACTIVE"),
      ),
    );

  // Group players by teamId.
  const playersByTeam = new Map<number, number[]>();
  for (const p of teamPlayers) {
    const list = playersByTeam.get(p.teamId) ?? [];
    list.push(p.id);
    playersByTeam.set(p.teamId, list);
  }

  // 4. Build upsert values.
  let playersProjected = 0;
  const inserts: schema.ProjectedScoreEntryInsert[] = [];

  for (const fx of scheduledWithOdds) {
    const { fixtureId, homeTeamId, awayTeamId, odds } = fx;
    const homePlayers = playersByTeam.get(homeTeamId) ?? [];
    const awayPlayers = playersByTeam.get(awayTeamId) ?? [];

    for (const [playerIds, isHome] of [
      [homePlayers, true],
      [awayPlayers, false],
    ] as [number[], boolean][]) {
      for (const playerId of playerIds) {
        const shares = byPlayer.get(playerId);
        if (!shares) continue;

        const projected = projectPoints(shares, odds, isHome, ruleset);
        inserts.push({
          playerId,
          fixtureId,
          rulesetVersion: ruleset.version,
          projectedPoints: projected,
        });
        playersProjected++;
      }
    }
  }

  if (inserts.length === 0) {
    return {
      fixturesProcessed: scheduledWithOdds.length,
      playersProjected: 0,
      rulesetVersion: ruleset.version,
    };
  }

  // Upsert in chunks of 500 to avoid parameter limits.
  const CHUNK = 500;
  for (let i = 0; i < inserts.length; i += CHUNK) {
    const chunk = inserts.slice(i, i + CHUNK);
    await db
      .insert(schema.projectedScoreEntry)
      .values(chunk)
      .onConflictDoUpdate({
        target: [
          schema.projectedScoreEntry.playerId,
          schema.projectedScoreEntry.fixtureId,
          schema.projectedScoreEntry.rulesetVersion,
        ],
        set: {
          projectedPoints: schema.projectedScoreEntry.projectedPoints,
          computedAt: schema.projectedScoreEntry.computedAt,
        },
      });
  }

  return {
    fixturesProcessed: scheduledWithOdds.length,
    playersProjected,
    rulesetVersion: ruleset.version,
  };
}
