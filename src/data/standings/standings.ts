/**
 * Standings computation (Phase 5).
 *
 * Standings are a pure, recomputable view over `score_entry` + rosters -
 * never stored. Because `score_entry` is itself rebuilt whenever stats
 * ingest (Phase 2's `score:recompute`), recomputing standings on demand
 * means they are always current: that is the "live updates" story without
 * any caching or websocket machinery.
 *
 * A team's total (section 5) is cumulative: for each of the nine scoring
 * periods (the tournament stages) the best-ball optimizer picks the
 * highest-scoring legal XI from the 23-man roster, and the period points
 * are summed across all periods.
 *
 * Ranking applies the section 5.3 tie-breaker ladder in order:
 *   1. total points
 *   2. points scored by ALL the manager's rostered players in the Final
 *   3. total tournament goals by rostered players
 *   4. total tournament assists by rostered players
 *   5. shared placement (a full tie shares the rank)
 *
 * Implementation: a handful of bulk queries load everything for the
 * league, then all computation is in-memory and pure - easy to reason
 * about and cheap for a <=24-team league.
 */

import { eq, inArray } from "drizzle-orm";

import type { Db } from "../db/client.js";
import {
  fantasyTeam,
  fixture,
  league,
  player,
  rosterSlot,
  scoreEntry,
  statLine,
  stageEnum,
  type Position,
  type Stage,
} from "../db/schema.js";
import type { ScoringRuleset } from "../scoring/ruleset.js";
import {
  formationLabel,
  optimizeBestBall,
  type ScoredPlayer,
} from "./lineup.js";

/** The nine scoring periods, in tournament order. */
export const SCORING_PERIODS: readonly Stage[] = stageEnum.enumValues;

export interface XiSlot {
  playerId: number;
  fullName: string;
  position: Position;
  points: number;
}

export interface PeriodResult {
  stage: Stage;
  /** Conventional formation label, e.g. "4-3-3". */
  formation: string;
  points: number;
  xi: XiSlot[];
}

export interface TieBreakers {
  /** #2: points by ALL rostered players in the Final match. */
  finalMatchPoints: number;
  /** #3: tournament goals by all rostered players. */
  tournamentGoals: number;
  /** #4: tournament assists by all rostered players. */
  tournamentAssists: number;
}

export interface StandingsEntry {
  /** 1-based; tied teams share a rank (section 5.3 #5). */
  rank: number;
  fantasyTeamId: number;
  managerId: number;
  teamName: string;
  /** Cumulative best-ball total across all nine periods. */
  total: number;
  tieBreakers: TieBreakers;
  periods: PeriodResult[];
}

/**
 * Compute the full standings for a league, ranked by the section 5.3
 * ladder. Pure read - makes no writes.
 */
export async function computeStandings(
  db: Db,
  leagueId: number,
): Promise<StandingsEntry[]> {
  const [lg] = await db.select().from(league).where(eq(league.id, leagueId));
  if (!lg) throw new Error(`league ${leagueId} does not exist`);
  const rulesetVersion = (lg.scoringRuleset as ScoringRuleset).version;

  // --- bulk load -----------------------------------------------------------
  const teams = await db
    .select()
    .from(fantasyTeam)
    .where(eq(fantasyTeam.leagueId, leagueId));
  if (teams.length === 0) return [];

  const slots = await db
    .select()
    .from(rosterSlot)
    .where(eq(rosterSlot.leagueId, leagueId));

  const rosteredPlayerIds = Array.from(new Set(slots.map((s) => s.playerId)));
  const players =
    rosteredPlayerIds.length > 0
      ? await db.select().from(player).where(inArray(player.id, rosteredPlayerIds))
      : [];
  const playerById = new Map(players.map((p) => [p.id, p]));

  const fixtures = await db.select().from(fixture);
  const stageByFixtureId = new Map<number, Stage>(
    fixtures.map((f) => [f.id, f.stage]),
  );
  const finalFixtureIds = new Set(
    fixtures.filter((f) => f.stage === "FINAL").map((f) => f.id),
  );

  // score_entry for this league's ruleset only.
  const scores = await db
    .select()
    .from(scoreEntry)
    .where(eq(scoreEntry.rulesetVersion, rulesetVersion));
  // (playerId, fixtureId) -> points
  const scoreByKey = new Map<string, number>();
  for (const s of scores) {
    scoreByKey.set(`${s.playerId}:${s.fixtureId}`, s.points);
  }

  // stat_line for rostered players (raw goals/assists for tie-breakers).
  const stats =
    rosteredPlayerIds.length > 0
      ? await db
          .select()
          .from(statLine)
          .where(inArray(statLine.playerId, rosteredPlayerIds))
      : [];

  // --- per-team computation ------------------------------------------------
  const slotsByTeam = new Map<number, number[]>();
  for (const s of slots) {
    const list = slotsByTeam.get(s.fantasyTeamId) ?? [];
    list.push(s.playerId);
    slotsByTeam.set(s.fantasyTeamId, list);
  }

  const unranked: Omit<StandingsEntry, "rank">[] = teams.map((team) => {
    const rosterPlayerIds = slotsByTeam.get(team.id) ?? [];
    const rosterSet = new Set(rosterPlayerIds);

    // Per-period best-ball XI.
    const periods: PeriodResult[] = [];
    let total = 0;
    for (const stage of SCORING_PERIODS) {
      const scored: ScoredPlayer[] = rosterPlayerIds.map((pid) => {
        const p = playerById.get(pid);
        const points = sumPlayerPointsInStage(
          pid,
          stage,
          scoreByKey,
          stageByFixtureId,
        );
        return {
          playerId: pid,
          position: (p?.position ?? "MID") as Position,
          points,
        };
      });
      // Best-ball needs a complete legal roster; skip the optimizer for an
      // incomplete one (period contributes 0) rather than throwing.
      const result = canFieldXi(scored)
        ? optimizeBestBall(scored)
        : { formation: LEGAL_NONE, xi: [], points: 0 };
      total += result.points;
      periods.push({
        stage,
        formation: result.xi.length > 0 ? formationLabel(result.formation) : "-",
        points: result.points,
        xi: result.xi.map((sp) => ({
          playerId: sp.playerId,
          fullName: playerById.get(sp.playerId)?.fullName ?? `#${sp.playerId}`,
          position: sp.position,
          points: sp.points,
        })),
      });
    }

    // Tie-breakers.
    let finalMatchPoints = 0;
    for (const s of scores) {
      if (rosterSet.has(s.playerId) && finalFixtureIds.has(s.fixtureId)) {
        finalMatchPoints += s.points;
      }
    }
    let tournamentGoals = 0;
    let tournamentAssists = 0;
    for (const st of stats) {
      if (rosterSet.has(st.playerId)) {
        tournamentGoals += st.goals;
        tournamentAssists += st.assists;
      }
    }

    return {
      fantasyTeamId: team.id,
      managerId: team.managerId,
      teamName: team.name,
      total,
      tieBreakers: { finalMatchPoints, tournamentGoals, tournamentAssists },
      periods,
    };
  });

  return rankStandings(unranked);
}

/** Placeholder formation for an empty period (no XI fielded). */
const LEGAL_NONE = { GK: 1 as const, DEF: 0, MID: 0, FWD: 0 };

function sumPlayerPointsInStage(
  playerId: number,
  stage: Stage,
  scoreByKey: Map<string, number>,
  stageByFixtureId: Map<number, Stage>,
): number {
  let sum = 0;
  for (const [fixtureId, fxStage] of stageByFixtureId) {
    if (fxStage !== stage) continue;
    sum += scoreByKey.get(`${playerId}:${fixtureId}`) ?? 0;
  }
  return sum;
}

/** A roster can field an XI once it has 1 GK, 4 DEF, 2 MID, 2 FWD minimum. */
function canFieldXi(scored: readonly ScoredPlayer[]): boolean {
  const c: Record<Position, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const p of scored) c[p.position] += 1;
  return c.GK >= 1 && c.DEF >= 4 && c.MID >= 2 && c.FWD >= 2 && c.DEF + c.MID + c.FWD >= 10;
}

/**
 * Rank standings by the section 5.3 ladder. Pure: exported for unit tests.
 *
 * Teams equal on ALL FOUR ranked keys (total, final-match points,
 * tournament goals, tournament assists) share a rank; the next distinct
 * team takes the rank after the whole tied block (1, 2, 2, 4 style).
 */
export function rankStandings(
  entries: readonly Omit<StandingsEntry, "rank">[],
): StandingsEntry[] {
  const sorted = [...entries].sort(compareForRanking);
  const ranked: StandingsEntry[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const entry = sorted[i] as Omit<StandingsEntry, "rank">;
    const prev = i > 0 ? (sorted[i - 1] as Omit<StandingsEntry, "rank">) : null;
    const rank =
      prev !== null && compareForRanking(entry, prev) === 0
        ? (ranked[i - 1] as StandingsEntry).rank
        : i + 1;
    ranked.push({ ...entry, rank });
  }
  return ranked;
}

function compareForRanking(
  a: Omit<StandingsEntry, "rank">,
  b: Omit<StandingsEntry, "rank">,
): number {
  if (a.total !== b.total) return b.total - a.total;
  if (a.tieBreakers.finalMatchPoints !== b.tieBreakers.finalMatchPoints) {
    return b.tieBreakers.finalMatchPoints - a.tieBreakers.finalMatchPoints;
  }
  if (a.tieBreakers.tournamentGoals !== b.tieBreakers.tournamentGoals) {
    return b.tieBreakers.tournamentGoals - a.tieBreakers.tournamentGoals;
  }
  if (a.tieBreakers.tournamentAssists !== b.tieBreakers.tournamentAssists) {
    return b.tieBreakers.tournamentAssists - a.tieBreakers.tournamentAssists;
  }
  return 0;
}
