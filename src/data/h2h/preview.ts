/**
 * Matchup previews (Priority 4 leftover; phase-07/phase-09 roadmap) - DERIVED.
 *
 * A preview for every matchup of the CURRENT gameweek: the first period, in
 * ordinal order, that has a matchup and has not finalized. Nothing is
 * stored; everything comes from the same computeStandings pass computeH2h
 * already runs, plus (when Phase 6 projections are populated) a projected
 * best-ball total for each side from projected_score_entry.
 *
 * Per side: table rank + W-D-L record, recent form (points in the last
 * three finalized periods), season total, the team's two highest-scoring
 * players so far ("key players", summed from the fielded XIs), and the
 * projected period total (null when no projections exist for the period's
 * fixtures). The pairwise rivalry record so far completes the card.
 *
 * Pure builder + one read helper; no HTTP/auth/env here.
 */
import { eq, inArray } from "drizzle-orm";

import {
  assignFixturesToPeriods,
  type PeriodRef,
} from "../competition/periods.js";
import type { Db } from "../db/client.js";
import {
  fixture,
  player,
  projectedScoreEntry,
  rosterSlot,
  type LeagueRow,
  type Position,
} from "../db/schema.js";
import type { ScoringRuleset } from "../scoring/ruleset.js";
import {
  LEGAL_FORMATIONS,
  optimizeBestBall,
  type ScoredPlayer,
} from "../standings/lineup.js";
import type { StandingsEntry } from "../standings/standings.js";
import type {
  H2hTableEntry,
  MatchupResult,
  RivalryRecord,
} from "./results.js";

export interface MatchupPreviewSide {
  fantasyTeamId: number;
  teamName: string;
  /** Current H2H table rank. */
  rank: number;
  wins: number;
  draws: number;
  losses: number;
  /** Points in the last (up to) three FINALIZED periods, oldest first. */
  recentForm: number[];
  seasonTotal: number;
  /** Top two scorers so far, by points scored while fielded. */
  keyPlayers: { playerId: number; fullName: string; points: number }[];
  /** Projected best-ball total for the period; null without projections. */
  projected: number | null;
}

export interface MatchupPreview {
  matchupId: number;
  ordinal: number;
  label: string;
  home: MatchupPreviewSide;
  away: MatchupPreviewSide;
  /** Head-to-head record between the two so far; null before they've met. */
  rivalry: { homeWins: number; awayWins: number; draws: number } | null;
}

/** Round to 2dp, matching the scoring engine's display convention. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Can this set of players field at least one legal XI? */
function canFieldXi(players: readonly ScoredPlayer[]): boolean {
  const counts: Record<Position, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const p of players) counts[p.position] += 1;
  return LEGAL_FORMATIONS.some(
    (f) =>
      counts.GK >= f.GK &&
      counts.DEF >= f.DEF &&
      counts.MID >= f.MID &&
      counts.FWD >= f.FWD,
  );
}

/**
 * Projected best-ball period totals per team, from projected_score_entry.
 * Returns an empty map when the period has no projected rows (the common
 * state when the odds pipeline is not configured).
 */
async function projectedTotalsForOrdinal(
  db: Db,
  lg: LeagueRow,
  periods: readonly PeriodRef[],
  ordinal: number,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const fixtures = await db.select().from(fixture);
  const byFixture = assignFixturesToPeriods(periods, fixtures);
  const periodFixtureIds = fixtures
    .filter((f) => byFixture.get(f.id) === ordinal)
    .map((f) => f.id);
  if (periodFixtureIds.length === 0) return out;

  const slots = await db
    .select()
    .from(rosterSlot)
    .where(eq(rosterSlot.leagueId, lg.id));
  if (slots.length === 0) return out;
  const playerIds = Array.from(new Set(slots.map((s) => s.playerId)));

  const rulesetVersion = (lg.scoringRuleset as ScoringRuleset).version;
  const projected = await db
    .select()
    .from(projectedScoreEntry)
    .where(inArray(projectedScoreEntry.playerId, playerIds));
  const pointsByPlayer = new Map<number, number>();
  for (const row of projected) {
    if (row.rulesetVersion !== rulesetVersion) continue;
    if (!periodFixtureIds.includes(row.fixtureId)) continue;
    pointsByPlayer.set(
      row.playerId,
      (pointsByPlayer.get(row.playerId) ?? 0) + row.projectedPoints,
    );
  }
  if (pointsByPlayer.size === 0) return out;

  const players = await db
    .select({ id: player.id, position: player.position })
    .from(player)
    .where(inArray(player.id, playerIds));
  const positionById = new Map(players.map((p) => [p.id, p.position]));

  const slotsByTeam = new Map<number, number[]>();
  for (const s of slots) {
    const list = slotsByTeam.get(s.fantasyTeamId) ?? [];
    list.push(s.playerId);
    slotsByTeam.set(s.fantasyTeamId, list);
  }
  for (const [teamId, ids] of slotsByTeam) {
    // No projected rows for anyone on this roster = no data, not a zero
    // projection - leave the team out so the UI shows a dash.
    if (!ids.some((pid) => pointsByPlayer.has(pid))) continue;
    const scored: ScoredPlayer[] = ids.map((pid) => ({
      playerId: pid,
      position: (positionById.get(pid) ?? "MID") as Position,
      points: pointsByPlayer.get(pid) ?? 0,
    }));
    if (!canFieldXi(scored)) continue;
    out.set(teamId, round2(optimizeBestBall(scored).points));
  }
  return out;
}

/**
 * Build the preview cards for the current gameweek: the first unfinalized
 * period that has matchups. Empty when the season is over or no schedule
 * exists.
 */
export async function computeMatchupPreviews(
  db: Db,
  lg: LeagueRow,
  periods: readonly PeriodRef[],
  finalized: ReadonlySet<number>,
  standings: readonly StandingsEntry[],
  results: readonly MatchupResult[],
  table: readonly H2hTableEntry[],
  rivalries: readonly RivalryRecord[],
): Promise<MatchupPreview[]> {
  const upcoming = results.filter((r) => !finalized.has(r.ordinal));
  if (upcoming.length === 0) return [];
  const ordinal = Math.min(...upcoming.map((r) => r.ordinal));
  const week = upcoming.filter((r) => r.ordinal === ordinal);

  const projected = await projectedTotalsForOrdinal(db, lg, periods, ordinal);

  const entryByTeam = new Map(standings.map((s) => [s.fantasyTeamId, s]));
  const tableByTeam = new Map(table.map((t) => [t.fantasyTeamId, t]));
  const finalizedOrdinalsAsc = periods
    .filter((p) => finalized.has(p.ordinal))
    .map((p) => p.ordinal)
    .sort((a, b) => a - b);

  const side = (teamId: number): MatchupPreviewSide => {
    const entry = entryByTeam.get(teamId);
    const t = tableByTeam.get(teamId);
    // Points per finalized period, oldest first (entry.periods aligns with
    // `periods` by index - same convention computeH2h relies on).
    const byOrdinal = new Map<number, number>();
    entry?.periods.forEach((p, i) => {
      const ref = periods[i];
      if (ref) byOrdinal.set(ref.ordinal, p.points);
    });
    const recentForm = finalizedOrdinalsAsc
      .slice(-3)
      .map((o) => byOrdinal.get(o) ?? 0);
    // Key players: sum each player's points across the fielded XIs so far.
    const totals = new Map<number, { fullName: string; points: number }>();
    for (const p of entry?.periods ?? []) {
      for (const xi of p.xi) {
        const cur = totals.get(xi.playerId);
        totals.set(xi.playerId, {
          fullName: xi.fullName,
          points: round2((cur?.points ?? 0) + xi.points),
        });
      }
    }
    const keyPlayers = [...totals.entries()]
      .map(([playerId, v]) => ({ playerId, ...v }))
      .sort((a, b) => b.points - a.points || a.playerId - b.playerId)
      .slice(0, 2);
    return {
      fantasyTeamId: teamId,
      teamName: t?.teamName ?? `Team #${teamId}`,
      rank: t?.rank ?? 0,
      wins: t?.wins ?? 0,
      draws: t?.draws ?? 0,
      losses: t?.losses ?? 0,
      recentForm,
      seasonTotal: entry?.total ?? 0,
      keyPlayers,
      projected: projected.get(teamId) ?? null,
    };
  };

  return week.map((m) => {
    const rivalry = rivalries.find(
      (r) =>
        (r.teamAId === m.homeFantasyTeamId && r.teamBId === m.awayFantasyTeamId) ||
        (r.teamAId === m.awayFantasyTeamId && r.teamBId === m.homeFantasyTeamId),
    );
    const homeIsA = rivalry?.teamAId === m.homeFantasyTeamId;
    return {
      matchupId: m.matchupId,
      ordinal: m.ordinal,
      label: m.label,
      home: side(m.homeFantasyTeamId),
      away: side(m.awayFantasyTeamId),
      rivalry:
        rivalry && rivalry.aWins + rivalry.bWins + rivalry.draws > 0
          ? {
              homeWins: homeIsA ? rivalry.aWins : rivalry.bWins,
              awayWins: homeIsA ? rivalry.bWins : rivalry.aWins,
              draws: rivalry.draws,
            }
          : null,
    };
  });
}
