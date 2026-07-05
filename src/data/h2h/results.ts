/**
 * Head-to-head results, table and rivalries (Phase 9 Priority 2) - DERIVED.
 *
 * Nothing here is stored. A matchup's result is a pure function of the two
 * teams' period totals, which come from computeStandings - i.e. from
 * whatever base format the league runs (best-ball optimizer or submitted
 * SET_LINEUP XIs). Stat corrections therefore correct every matchup,
 * record and rivalry automatically, exactly like the standings page.
 *
 * A period counts toward W-D-L records only once it FINALIZES: it has at
 * least one fixture and every fixture is FINISHED. Live/upcoming matchups
 * are still returned (with current points) but with outcome null.
 *
 * Table ranking: H2H points (win 3 / draw 1 / loss 0) desc, then total
 * fantasy points desc; full ties share a rank (1, 2, 2, 4 style).
 */
import { eq } from "drizzle-orm";

import {
  assignFixturesToPeriods,
  getScoringPeriods,
  type PeriodRef,
} from "../competition/periods.js";
import type { Db } from "../db/client.js";
import { fixture, league, matchup, type MatchupRow } from "../db/schema.js";
import { computeStandings } from "../standings/standings.js";
import { H2hError } from "./errors.js";

export const H2H_POINTS = { WIN: 3, DRAW: 1, LOSS: 0 } as const;

export type MatchupOutcome = "HOME" | "AWAY" | "DRAW";

export interface MatchupResult {
  matchupId: number;
  scoringPeriodId: number;
  ordinal: number;
  label: string;
  homeFantasyTeamId: number;
  awayFantasyTeamId: number;
  homePoints: number;
  awayPoints: number;
  finalized: boolean;
  /** Null until the period finalizes. */
  outcome: MatchupOutcome | null;
}

export interface H2hTableEntry {
  rank: number;
  fantasyTeamId: number;
  teamName: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  h2hPoints: number;
  /** Season fantasy-point total - the tie-breaker. */
  totalPoints: number;
}

export interface RivalryRecord {
  teamAId: number;
  teamBId: number;
  aWins: number;
  bWins: number;
  draws: number;
}

/**
 * The ordinals of finalized periods: >= 1 fixture assigned and all of them
 * FINISHED. Shared with the schedule service's regeneration lock.
 */
export async function finalizedOrdinals(
  db: Db,
  periods: readonly PeriodRef[],
): Promise<Set<number>> {
  const fixtures = await db.select().from(fixture);
  const assigned = assignFixturesToPeriods(periods, fixtures);
  const total = new Map<number, number>();
  const finished = new Map<number, number>();
  for (const f of fixtures) {
    const ord = assigned.get(f.id);
    if (ord === undefined) continue;
    total.set(ord, (total.get(ord) ?? 0) + 1);
    if (f.status === "FINISHED") finished.set(ord, (finished.get(ord) ?? 0) + 1);
  }
  const out = new Set<number>();
  for (const [ord, n] of total) {
    if ((finished.get(ord) ?? 0) === n) out.add(ord);
  }
  return out;
}

/** Decide every matchup from period totals - pure. */
export function buildMatchupResults(
  matchups: readonly MatchupRow[],
  periodById: ReadonlyMap<number, PeriodRef>,
  pointsByTeamOrdinal: ReadonlyMap<number, ReadonlyMap<number, number>>,
  finalized: ReadonlySet<number>,
): MatchupResult[] {
  const out: MatchupResult[] = [];
  for (const m of matchups) {
    const period = periodById.get(m.scoringPeriodId);
    if (!period) continue; // period of another competition; ignore
    const homePoints =
      pointsByTeamOrdinal.get(m.homeFantasyTeamId)?.get(period.ordinal) ?? 0;
    const awayPoints =
      pointsByTeamOrdinal.get(m.awayFantasyTeamId)?.get(period.ordinal) ?? 0;
    const isFinal = finalized.has(period.ordinal);
    let outcome: MatchupOutcome | null = null;
    if (isFinal) {
      outcome =
        homePoints > awayPoints ? "HOME" : awayPoints > homePoints ? "AWAY" : "DRAW";
    }
    out.push({
      matchupId: m.id,
      scoringPeriodId: m.scoringPeriodId,
      ordinal: period.ordinal,
      label: period.label,
      homeFantasyTeamId: m.homeFantasyTeamId,
      awayFantasyTeamId: m.awayFantasyTeamId,
      homePoints,
      awayPoints,
      finalized: isFinal,
      outcome,
    });
  }
  out.sort((a, b) => a.ordinal - b.ordinal || a.matchupId - b.matchupId);
  return out;
}

/** Aggregate finalized results into the ranked W-D-L table - pure. */
export function buildH2hTable(
  results: readonly MatchupResult[],
  teams: ReadonlyArray<{ fantasyTeamId: number; teamName: string; totalPoints: number }>,
): H2hTableEntry[] {
  const recs = new Map<
    number,
    { wins: number; draws: number; losses: number }
  >();
  for (const t of teams) recs.set(t.fantasyTeamId, { wins: 0, draws: 0, losses: 0 });
  for (const r of results) {
    if (r.outcome === null) continue;
    const home = recs.get(r.homeFantasyTeamId);
    const away = recs.get(r.awayFantasyTeamId);
    if (!home || !away) continue;
    if (r.outcome === "HOME") {
      home.wins += 1;
      away.losses += 1;
    } else if (r.outcome === "AWAY") {
      away.wins += 1;
      home.losses += 1;
    } else {
      home.draws += 1;
      away.draws += 1;
    }
  }

  const unranked = teams.map((t) => {
    const rec = recs.get(t.fantasyTeamId) ?? { wins: 0, draws: 0, losses: 0 };
    return {
      fantasyTeamId: t.fantasyTeamId,
      teamName: t.teamName,
      played: rec.wins + rec.draws + rec.losses,
      wins: rec.wins,
      draws: rec.draws,
      losses: rec.losses,
      h2hPoints: rec.wins * H2H_POINTS.WIN + rec.draws * H2H_POINTS.DRAW,
      totalPoints: t.totalPoints,
    };
  });

  const cmp = (
    a: (typeof unranked)[number],
    b: (typeof unranked)[number],
  ): number =>
    b.h2hPoints - a.h2hPoints ||
    b.totalPoints - a.totalPoints ||
    a.fantasyTeamId - b.fantasyTeamId;
  const keyEq = (a: (typeof unranked)[number], b: (typeof unranked)[number]) =>
    a.h2hPoints === b.h2hPoints && a.totalPoints === b.totalPoints;

  const sorted = [...unranked].sort(cmp);
  const out: H2hTableEntry[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const entry = sorted[i] as (typeof unranked)[number];
    const prev = i > 0 ? (sorted[i - 1] as (typeof unranked)[number]) : null;
    const rank = prev !== null && keyEq(entry, prev) ? (out[i - 1] as H2hTableEntry).rank : i + 1;
    out.push({ rank, ...entry });
  }
  return out;
}

/** Cumulative records between every pair that has met (finalized only). */
export function buildRivalries(results: readonly MatchupResult[]): RivalryRecord[] {
  const byPair = new Map<string, RivalryRecord>();
  for (const r of results) {
    if (r.outcome === null) continue;
    const [a, b] =
      r.homeFantasyTeamId < r.awayFantasyTeamId
        ? [r.homeFantasyTeamId, r.awayFantasyTeamId]
        : [r.awayFantasyTeamId, r.homeFantasyTeamId];
    const key = `${a}:${b}`;
    const rec = byPair.get(key) ?? { teamAId: a, teamBId: b, aWins: 0, bWins: 0, draws: 0 };
    if (r.outcome === "DRAW") {
      rec.draws += 1;
    } else {
      const winner = r.outcome === "HOME" ? r.homeFantasyTeamId : r.awayFantasyTeamId;
      if (winner === a) rec.aWins += 1;
      else rec.bWins += 1;
    }
    byPair.set(key, rec);
  }
  return [...byPair.values()].sort(
    (x, y) => x.teamAId - y.teamAId || x.teamBId - y.teamBId,
  );
}

export interface H2hView {
  periods: Array<{
    scoringPeriodId: number | null;
    ordinal: number;
    label: string;
    finalized: boolean;
  }>;
  results: MatchupResult[];
  table: H2hTableEntry[];
  rivalries: RivalryRecord[];
}

/**
 * The full head-to-head view for a league: every matchup with its (possibly
 * in-progress) points, the ranked W-D-L table over finalized periods, and
 * pairwise rivalry records. One standings computation feeds everything.
 */
export async function computeH2h(db: Db, leagueId: number): Promise<H2hView> {
  const [lg] = await db.select().from(league).where(eq(league.id, leagueId));
  if (!lg) throw new H2hError(`league ${leagueId} does not exist`, "LEAGUE_NOT_FOUND");

  const periods = await getScoringPeriods(db, lg.competitionId);
  const periodById = new Map<number, PeriodRef>();
  for (const p of periods) if (p.id !== null) periodById.set(p.id, p);

  const rows = await db.select().from(matchup).where(eq(matchup.leagueId, leagueId));
  const finalized = await finalizedOrdinals(db, periods);

  const standings = await computeStandings(db, leagueId);
  // entry.periods[i] corresponds to periods[i] (same list, same order).
  const pointsByTeamOrdinal = new Map<number, Map<number, number>>();
  for (const entry of standings) {
    const m = new Map<number, number>();
    entry.periods.forEach((p, i) => {
      const ref = periods[i];
      if (ref) m.set(ref.ordinal, p.points);
    });
    pointsByTeamOrdinal.set(entry.fantasyTeamId, m);
  }

  const results = buildMatchupResults(rows, periodById, pointsByTeamOrdinal, finalized);
  const table = buildH2hTable(
    results,
    standings.map((s) => ({
      fantasyTeamId: s.fantasyTeamId,
      teamName: s.teamName,
      totalPoints: s.total,
    })),
  );
  return {
    periods: periods.map((p) => ({
      scoringPeriodId: p.id,
      ordinal: p.ordinal,
      label: p.label,
      finalized: finalized.has(p.ordinal),
    })),
    results,
    table,
    rivalries: buildRivalries(results),
  };
}
