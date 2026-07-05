/**
 * Head-to-head schedule generation (Phase 9 Priority 2).
 *
 * Pairs the league's fantasy teams for each scoring period of its
 * competition using the classic circle-method round-robin: deterministic
 * (teams ordered by id), odd team counts get a bye per round (the unpaired
 * team simply has no matchup that period), and when there are more periods
 * than round-robin rounds the rotation wraps so repeat meetings stay
 * balanced. Home/away alternates by cycle for fairness (cosmetic - scoring
 * is symmetric).
 *
 * Only the SCHEDULE is stored (the `matchup` table). Results are derived at
 * read time by src/data/h2h/results.ts from the same period totals the
 * standings use, so they work for BEST_BALL and SET_LINEUP alike and
 * self-correct after stat corrections.
 *
 * Regeneration lock (per phase-04): the owner may regenerate freely until
 * the first scheduled period FINALIZES (all its fixtures FINISHED); after
 * that the schedule is history and stays. Enabling H2H mid-tournament is
 * allowed - earlier periods score retroactively, exactly like standings.
 *
 * Pure service: takes a Db and plain inputs; no HTTP/auth/env here.
 */
import { asc, eq } from "drizzle-orm";

import { getScoringPeriods } from "../competition/periods.js";
import type { Db } from "../db/client.js";
import {
  fantasyTeam,
  league,
  matchup,
  type MatchupRow,
} from "../db/schema.js";
import { isFlagEnabled } from "../league/feature-flags.js";
import { finalizedOrdinals } from "./results.js";
import { H2hError } from "./errors.js";

export interface Pairing {
  home: number;
  away: number;
}

/**
 * Deterministic circle-method round-robin. Returns one list of pairings per
 * period (index 0 = first period). Odd team counts: one team per round sits
 * out (paired against the phantom "bye" and dropped). With more periods
 * than rounds the rotation wraps (everyone meets again in the same order);
 * with fewer, it truncates (a balanced partial round-robin).
 */
export function generateRoundRobin(
  teamIds: readonly number[],
  numPeriods: number,
): Pairing[][] {
  const teams: Array<number | null> = [...teamIds].sort((a, b) => a - b);
  if (teams.length % 2 === 1) teams.push(null); // bye slot
  const n = teams.length;
  const roundsPerCycle = Math.max(n - 1, 1);

  const out: Pairing[][] = [];
  for (let p = 0; p < numPeriods; p += 1) {
    const round = p % roundsPerCycle;
    const cycle = Math.floor(p / roundsPerCycle);
    // Circle method: fix teams[0], rotate the rest by `round`.
    const rot: Array<number | null> = [
      teams[0] ?? null,
      ...teams.slice(1).map((_, i, rest) => rest[(i + round) % rest.length] ?? null),
    ];
    const pairings: Pairing[] = [];
    for (let i = 0; i < n / 2; i += 1) {
      const a = rot[i] ?? null;
      const b = rot[n - 1 - i] ?? null;
      if (a === null || b === null) continue; // bye
      // Alternate orientation by round + cycle so home/away balances.
      const flip = (round + cycle + i) % 2 === 1;
      pairings.push(flip ? { home: b, away: a } : { home: a, away: b });
    }
    out.push(pairings);
  }
  return out;
}

export interface GenerateScheduleResult {
  leagueId: number;
  periods: number;
  matchups: number;
  regenerated: boolean;
}

/**
 * Generate (or regenerate) the league's full matchup schedule. Requires the
 * head_to_head flag ON, a league with a competition (matchups key on real
 * scoring_period rows) and at least two teams. Regeneration is blocked once
 * any scheduled period has finalized.
 */
export async function generateSchedule(
  db: Db,
  leagueId: number,
): Promise<GenerateScheduleResult> {
  const [lg] = await db.select().from(league).where(eq(league.id, leagueId));
  if (!lg) throw new H2hError(`league ${leagueId} does not exist`, "LEAGUE_NOT_FOUND");
  if (!(await isFlagEnabled(db, leagueId, "head_to_head"))) {
    throw new H2hError(
      `league ${leagueId} does not have the head_to_head flag enabled`,
      "H2H_FLAG_DISABLED",
    );
  }
  if (lg.competitionId === null) {
    throw new H2hError(
      `league ${leagueId} has no competition; head-to-head needs scoring_period rows`,
      "H2H_REQUIRES_COMPETITION",
    );
  }

  const periods = await getScoringPeriods(db, lg.competitionId);
  const realPeriods = periods.filter(
    (p): p is typeof p & { id: number } => p.id !== null,
  );
  if (realPeriods.length === 0) {
    throw new H2hError(
      `competition ${lg.competitionId} has no scoring periods`,
      "H2H_REQUIRES_COMPETITION",
    );
  }

  const teams = await db
    .select()
    .from(fantasyTeam)
    .where(eq(fantasyTeam.leagueId, leagueId))
    .orderBy(asc(fantasyTeam.id));
  if (teams.length < 2) {
    throw new H2hError(
      "head-to-head needs at least two fantasy teams",
      "H2H_NOT_ENOUGH_TEAMS",
    );
  }

  const existing = await db
    .select()
    .from(matchup)
    .where(eq(matchup.leagueId, leagueId));
  if (existing.length > 0) {
    const scheduledPeriodIds = new Set(existing.map((m) => m.scoringPeriodId));
    const done = await finalizedOrdinals(db, periods);
    const lockedOrdinal = realPeriods.find(
      (p) => scheduledPeriodIds.has(p.id) && done.has(p.ordinal),
    );
    if (lockedOrdinal) {
      throw new H2hError(
        `schedule is locked: period "${lockedOrdinal.label}" has finalized`,
        "H2H_SCHEDULE_LOCKED",
      );
    }
  }

  const rounds = generateRoundRobin(
    teams.map((t) => t.id),
    realPeriods.length,
  );

  return db.transaction(async (tx) => {
    if (existing.length > 0) {
      await tx.delete(matchup).where(eq(matchup.leagueId, leagueId));
    }
    let written = 0;
    for (const [i, pairings] of rounds.entries()) {
      const period = realPeriods[i];
      if (!period) continue;
      for (const pair of pairings) {
        await tx.insert(matchup).values({
          leagueId,
          scoringPeriodId: period.id,
          homeFantasyTeamId: pair.home,
          awayFantasyTeamId: pair.away,
        });
        written += 1;
      }
    }
    return {
      leagueId,
      periods: realPeriods.length,
      matchups: written,
      regenerated: existing.length > 0,
    };
  });
}

/** The league's stored schedule, ordered for display. */
export async function getSchedule(db: Db, leagueId: number): Promise<MatchupRow[]> {
  return db
    .select()
    .from(matchup)
    .where(eq(matchup.leagueId, leagueId))
    .orderBy(asc(matchup.scoringPeriodId), asc(matchup.id));
}
