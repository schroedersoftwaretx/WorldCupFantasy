/**
 * Read-side helpers for the W5 standings / in-season view.
 *
 * getRosterScores() is the roster-detail query: it returns the 23 rostered
 * players for one fantasy team annotated with their raw per-period points
 * and a flag indicating whether they were selected in the best-ball XI for
 * that period. It reuses computeStandings internally so the XI selection is
 * computed by the same optimizer that drives the overall standings.
 */
import { eq, inArray } from "drizzle-orm";

import type { Db } from "../data/db/client.js";
import {
  fantasyTeam,
  fixture,
  manager,
  nationalTeam,
  player,
  rosterSlot,
  scoreEntry,
  stageEnum,
  type Stage,
} from "../data/db/schema.js";
import type { ScoringRuleset } from "../data/scoring/ruleset.js";
import { league } from "../data/db/schema.js";
import {
  formationLabel,
  optimizeBestBall,
  type ScoredPlayer,
} from "../data/standings/lineup.js";
import type { PeriodResult, XiSlot } from "../data/standings/standings.js";
import type { RosterPlayerScore, RosterViewData } from "./api-types.js";

/** The nine scoring periods in tournament order. */
const SCORING_PERIODS: readonly Stage[] = stageEnum.enumValues;

/**
 * Returns the full roster view for one fantasy team: each player's raw
 * points per scoring period, whether they were selected in the best-ball XI
 * for that period, and the team's cumulative total.
 *
 * Throws if the league or team does not exist.
 */
export async function getRosterScores(
  db: Db,
  leagueId: number,
  teamId: number,
): Promise<RosterViewData> {
  // --- load league + team -----------------------------------------------
  const [lg] = await db.select().from(league).where(eq(league.id, leagueId));
  if (!lg) throw new Error(`league ${leagueId} does not exist`);
  const rulesetVersion = (lg.scoringRuleset as ScoringRuleset).version;

  const [team] = await db
    .select()
    .from(fantasyTeam)
    .where(eq(fantasyTeam.id, teamId));
  if (!team || team.leagueId !== leagueId) {
    throw new Error(`team ${teamId} not found in league ${leagueId}`);
  }

  // Manager display name.
  const [mgr] = await db
    .select()
    .from(manager)
    .where(eq(manager.id, team.managerId));

  // --- roster players ---------------------------------------------------
  const slots = await db
    .select()
    .from(rosterSlot)
    .where(eq(rosterSlot.fantasyTeamId, teamId));
  const playerIds = slots.map((s) => s.playerId);

  if (playerIds.length === 0) {
    return {
      leagueId,
      teamId,
      teamName: team.name,
      managerId: team.managerId,
      managerName: mgr?.displayName ?? `manager #${team.managerId}`,
      players: [],
      total: 0,
    };
  }

  const players = await db
    .select({
      id: player.id,
      fullName: player.fullName,
      position: player.position,
      nationalTeam: nationalTeam.name,
    })
    .from(player)
    .innerJoin(nationalTeam, eq(nationalTeam.id, player.nationalTeamId))
    .where(inArray(player.id, playerIds));

  // --- score_entry for these players + this ruleset ---------------------
  const scores = await db
    .select()
    .from(scoreEntry)
    .where(eq(scoreEntry.rulesetVersion, rulesetVersion));

  const fixtures = await db.select().from(fixture);
  const stageByFixtureId = new Map<number, Stage>(
    fixtures.map((f) => [f.id, f.stage]),
  );

  // (playerId, stage) -> raw points
  function playerPointsInStage(playerId: number, stage: Stage): number {
    let sum = 0;
    for (const s of scores) {
      if (
        s.playerId === playerId &&
        stageByFixtureId.get(s.fixtureId) === stage
      ) {
        sum += s.points;
      }
    }
    return sum;
  }

  // --- best-ball XI per period -----------------------------------------
  // Build the ScoredPlayer roster for each period so we can call the
  // same optimizer used by computeStandings.
  const xiPlayerIds: Set<number>[] = [];
  let teamTotal = 0;

  for (const stage of SCORING_PERIODS) {
    const scored: ScoredPlayer[] = players.map((p) => ({
      playerId: p.id,
      position: p.position,
      points: playerPointsInStage(p.id, stage),
    }));
    // Can we field a legal XI?
    const counts = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
    for (const sp of scored) counts[sp.position] += 1;
    const canField =
      counts.GK >= 1 &&
      counts.DEF >= 4 &&
      counts.MID >= 2 &&
      counts.FWD >= 2 &&
      counts.DEF + counts.MID + counts.FWD >= 10;

    const xiIds = new Set<number>();
    if (canField) {
      const result = optimizeBestBall(scored);
      for (const sp of result.xi) xiIds.add(sp.playerId);
      teamTotal += result.points;
    }
    xiPlayerIds.push(xiIds);
  }

  // --- assemble per-player output ----------------------------------------
  const playerById = new Map(players.map((p) => [p.id, p]));

  const rosterPlayers: RosterPlayerScore[] = playerIds.map((pid) => {
    const p = playerById.get(pid)!;
    let totalPoints = 0;
    const periodScores = SCORING_PERIODS.map((stage, idx) => {
      const points = playerPointsInStage(pid, stage);
      const inXi = xiPlayerIds[idx]?.has(pid) ?? false;
      if (inXi) totalPoints += points;
      return { stage, points, inXi };
    });
    return {
      playerId: pid,
      fullName: p.fullName,
      position: p.position,
      nationalTeam: p.nationalTeam,
      totalPoints,
      periods: periodScores,
    };
  });

  // Sort by total points desc, then name.
  rosterPlayers.sort((a, b) => {
    if (a.totalPoints !== b.totalPoints) return b.totalPoints - a.totalPoints;
    return a.fullName.localeCompare(b.fullName);
  });

  return {
    leagueId,
    teamId,
    teamName: team.name,
    managerId: team.managerId,
    managerName: mgr?.displayName ?? `manager #${team.managerId}`,
    players: rosterPlayers,
    total: teamTotal,
  };
}
