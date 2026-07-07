/**
 * Auto stage recaps + power rankings (phase-03 3.3) - deterministic.
 *
 * After a stage's fixtures all finish, each chat-enabled league gets ONE
 * STAGE_RECAP activity event (idempotent under cron reruns via the partial
 * unique index on (league_id, payload->>'stage')). The recap object is a
 * pure, deterministic function of computed standings + snapshots + H2H
 * results - no external model; copy is templated by the UI.
 *
 * Power-ranking movement is the diff of consecutive standings_snapshot
 * cumulative ranks (the same rows the standings page's arrows use); the
 * power ORDER blends season total with the stage's form (total + stage
 * points, 2dp).
 */
import { eq } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { activityEvent, league, matchup, type Stage } from "../db/schema.js";
import { computeH2h, type MatchupResult } from "../h2h/results.js";
import { isFlagEnabled } from "../league/feature-flags.js";
import { getSnapshotRanks, scoredStages } from "../standings/snapshot.js";
import {
  computeStandings,
  SCORING_PERIODS,
  type StandingsEntry,
} from "../standings/standings.js";
import { recordEvent } from "./activity.js";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface PowerRankingEntry {
  rank: number;
  fantasyTeamId: number;
  teamName: string;
  /** Season total + this stage's points, 2dp - rewards current form. */
  powerScore: number;
  /** Snapshot-rank diff vs the previous scored stage (positive = climbed);
   * null when there is no previous stage or no snapshot. */
  movement: number | null;
}

export interface StageRecap {
  stage: string;
  managerOfStage: { teamNames: string[]; points: number } | null;
  biggestBlowout: {
    winnerName: string;
    loserName: string;
    margin: number;
    /** "H2H" when from a matchup, "STAGE" when best-vs-worst stage total. */
    kind: "H2H" | "STAGE";
  } | null;
  topHaul: { playerName: string; teamName: string; points: number } | null;
  powerRankings: PowerRankingEntry[];
}

/** Pure: rank by season total + stage form; movement from snapshot ranks. */
export function buildPowerRankings(
  entries: readonly StandingsEntry[],
  stage: Stage,
  currRanks: ReadonlyMap<number, number>,
  prevRanks: ReadonlyMap<number, number> | null,
): PowerRankingEntry[] {
  const scored = entries.map((e) => ({
    fantasyTeamId: e.fantasyTeamId,
    teamName: e.teamName,
    powerScore: round2(
      e.total + (e.periods.find((p) => p.stage === stage)?.points ?? 0),
    ),
  }));
  scored.sort(
    (a, b) => b.powerScore - a.powerScore || a.fantasyTeamId - b.fantasyTeamId,
  );
  return scored.map((s, i) => {
    const curr = currRanks.get(s.fantasyTeamId);
    const prev = prevRanks?.get(s.fantasyTeamId);
    return {
      rank: i + 1,
      ...s,
      movement:
        curr !== undefined && prev !== undefined ? prev - curr : null,
    };
  });
}

/** Pure: assemble the deterministic recap for one stage. */
export function buildStageRecap(
  stage: Stage,
  entries: readonly StandingsEntry[],
  stageMatchups: readonly MatchupResult[],
  currRanks: ReadonlyMap<number, number>,
  prevRanks: ReadonlyMap<number, number> | null,
): StageRecap {
  const nameByTeam = new Map(entries.map((e) => [e.fantasyTeamId, e.teamName]));
  const stagePoints = (e: StandingsEntry): number =>
    e.periods.find((p) => p.stage === stage)?.points ?? 0;

  // Manager of the stage: top stage total (ties share).
  let managerOfStage: StageRecap["managerOfStage"] = null;
  if (entries.length > 0) {
    const best = Math.max(...entries.map(stagePoints));
    if (best > 0) {
      managerOfStage = {
        teamNames: entries
          .filter((e) => stagePoints(e) === best)
          .map((e) => e.teamName)
          .sort(),
        points: best,
      };
    }
  }

  // Biggest blowout: widest finalized H2H margin, else best-vs-worst stage
  // totals.
  let biggestBlowout: StageRecap["biggestBlowout"] = null;
  const decided = stageMatchups.filter(
    (m) => m.outcome === "HOME" || m.outcome === "AWAY",
  );
  if (decided.length > 0) {
    const top = [...decided].sort(
      (a, b) =>
        Math.abs(b.homePoints - b.awayPoints) -
          Math.abs(a.homePoints - a.awayPoints) || a.matchupId - b.matchupId,
    )[0] as MatchupResult;
    const homeWon = top.outcome === "HOME";
    biggestBlowout = {
      winnerName:
        nameByTeam.get(homeWon ? top.homeFantasyTeamId : top.awayFantasyTeamId) ??
        "?",
      loserName:
        nameByTeam.get(homeWon ? top.awayFantasyTeamId : top.homeFantasyTeamId) ??
        "?",
      margin: round2(Math.abs(top.homePoints - top.awayPoints)),
      kind: "H2H",
    };
  } else if (entries.length >= 2) {
    const byStage = [...entries].sort(
      (a, b) => stagePoints(b) - stagePoints(a) || a.fantasyTeamId - b.fantasyTeamId,
    );
    const first = byStage[0] as StandingsEntry;
    const last = byStage[byStage.length - 1] as StandingsEntry;
    const margin = round2(stagePoints(first) - stagePoints(last));
    if (margin > 0) {
      biggestBlowout = {
        winnerName: first.teamName,
        loserName: last.teamName,
        margin,
        kind: "STAGE",
      };
    }
  }

  // Top haul: the best single XI slot of the stage.
  let topHaul: StageRecap["topHaul"] = null;
  for (const e of entries) {
    for (const p of e.periods) {
      if (p.stage !== stage) continue;
      for (const slot of p.xi) {
        if (
          topHaul === null ||
          slot.points > topHaul.points ||
          (slot.points === topHaul.points &&
            slot.fullName.localeCompare(topHaul.playerName) < 0)
        ) {
          topHaul = {
            playerName: slot.fullName,
            teamName: e.teamName,
            points: slot.points,
          };
        }
      }
    }
  }

  return {
    stage,
    managerOfStage,
    biggestBlowout,
    topHaul,
    powerRankings: buildPowerRankings(entries, stage, currRanks, prevRanks),
  };
}

/**
 * Generate any missing stage recaps for one league. A stage qualifies once
 * it has non-zero points (scoredStages). Idempotent: existing STAGE_RECAP
 * events are skipped, and the DB's partial unique index backstops races.
 * Gated by the `chat` flag (phase-03 is one feature).
 */
export async function generateStageRecapsForLeague(
  db: Db,
  leagueId: number,
): Promise<number> {
  if (!(await isFlagEnabled(db, leagueId, "chat"))) return 0;

  const entries = await computeStandings(db, leagueId);
  if (entries.length === 0) return 0;
  const stages = scoredStages(entries);
  if (stages.length === 0) return 0;

  const existing = await db
    .select()
    .from(activityEvent)
    .where(eq(activityEvent.leagueId, leagueId));
  const done = new Set(
    existing
      .filter((e) => e.type === "STAGE_RECAP")
      .map((e) => (e.payload as { stage?: string }).stage),
  );

  const hasMatchups =
    (await db.select().from(matchup).where(eq(matchup.leagueId, leagueId)))
      .length > 0;
  const h2h = hasMatchups ? await computeH2h(db, leagueId) : null;

  let generated = 0;
  for (const [i, stage] of stages.entries()) {
    if (done.has(stage)) continue;
    const prevStage = i > 0 ? stages[i - 1] : undefined;
    const currRanks = await getSnapshotRanks(db, leagueId, stage);
    const prevRanks = prevStage
      ? await getSnapshotRanks(db, leagueId, prevStage)
      : null;
    // WC periods keep ordinal == stage-enum position + 1 (both the seeded
    // scoring_period rows and the fallback), so a stage maps to one ordinal.
    const stageOrdinal = SCORING_PERIODS.indexOf(stage) + 1;
    const stageMatchups = (h2h?.results ?? []).filter(
      (r) => r.ordinal === stageOrdinal && r.finalized,
    );
    const recap = buildStageRecap(
      stage,
      entries,
      stageMatchups,
      currRanks,
      prevRanks,
    );
    try {
      await db
        .insert(activityEvent)
        .values({ leagueId, type: "STAGE_RECAP", payload: recap })
        .onConflictDoNothing();
      generated += 1;
    } catch {
      /* unique-index race: another run already wrote it */
    }
  }
  return generated;
}

/** Recap every league; one broken league cannot fail the cron. */
export async function generateAllStageRecaps(
  db: Db,
): Promise<{ leagues: number; generated: number; errors: number }> {
  const leagues = await db.select({ id: league.id }).from(league);
  let generated = 0;
  let errors = 0;
  for (const lg of leagues) {
    try {
      generated += await generateStageRecapsForLeague(db, lg.id);
    } catch {
      errors += 1;
    }
  }
  return { leagues: leagues.length, generated, errors };
}
