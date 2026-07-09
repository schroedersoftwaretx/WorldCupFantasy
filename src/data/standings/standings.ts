/**
 * Standings computation (Phase 5).
 *
 * Standings are a pure, recomputable view over `score_entry` + rosters -
 * never stored. Because `score_entry` is itself rebuilt whenever stats
 * ingest (Phase 2's `score:recompute`), recomputing standings on demand
 * means they are always current: that is the "live updates" story without
 * any caching or websocket machinery.
 *
 * A team's total (section 5) is cumulative: for each scoring period of the
 * league's competition (WC stages; PL gameweeks once seeded - Phase 9, read
 * from scoring_period) the best-ball optimizer picks the
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

import {
  assignFixturesToPeriods,
  getScoringPeriods,
} from "../competition/periods.js";
import type { Db } from "../db/client.js";
import { isFlagEnabled } from "../league/feature-flags.js";
import { getLedger, rosterAtOrdinal } from "../transactions/effective-roster.js";
import {
  effectiveLineupForOrdinal,
  getLineupsForTeams,
} from "../lineup/service.js";
import {
  chipPlay,
  fantasyTeam,
  fixture,
  league,
  periodCaptain,
  player,
  rosterSlot,
  scoreEntry,
  statLine,
  stageEnum,
  type ChipType,
  type Position,
  type Stage,
} from "../db/schema.js";
import type { ScoringRuleset } from "../scoring/ruleset.js";
import {
  formationLabel,
  optimizeBestBall,
  type ScoredPlayer,
} from "./lineup.js";
import {
  scoreSetLineupPeriod,
  type SetLineupSlotInput,
} from "./set-lineup.js";

/**
 * The nine World Cup stages, in tournament order. Since Phase 9 the standings
 * loop reads a league's periods from scoring_period (getScoringPeriods); this
 * constant remains as the stage-typed fallback ordering and for the
 * stage-keyed snapshot/view helpers, which are WC-specific.
 */
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

  // Scoring periods are data since Phase 9: the league's competition's
  // scoring_period rows, or the stage-enum fallback (identical for the WC).
  const periodRefs = await getScoringPeriods(db, lg.competitionId);

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

  // Transactions overlay (Priority 5): when the flag is on, per-period
  // rosters are reconstructed from the movement ledger. When off (the
  // default) the ledger is never read and everything below is byte-identical
  // to the pre-transactions computation.
  const txnsEnabled = await isFlagEnabled(db, leagueId, "transactions");
  const ledger = txnsEnabled ? await getLedger(db, leagueId) : [];

  const rosteredPlayerIds = Array.from(
    new Set([
      ...slots.map((s) => s.playerId),
      ...ledger.map((l) => l.playerId),
    ]),
  );
  const players =
    rosteredPlayerIds.length > 0
      ? await db.select().from(player).where(inArray(player.id, rosteredPlayerIds))
      : [];
  const playerById = new Map(players.map((p) => [p.id, p]));

  const fixtures = await db.select().from(fixture);
  // fixtureId -> period ordinal (scoring_period_id first, stage fallback).
  const ordinalByFixtureId = assignFixturesToPeriods(periodRefs, fixtures);
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

  // --- SET_LINEUP inputs (loaded ONLY for that format; best-ball leagues
  // never touch the lineup table) --------------------------------------------
  const isSetLineup = lg.format === "SET_LINEUP";
  const lineupsByTeam = new Map<number, Awaited<ReturnType<typeof getLineupsForTeams>>>();
  const ordinalByPeriodId = new Map<number, number>();
  const featuredByOrdinal = new Map<number, Set<number>>();
  if (isSetLineup) {
    for (const p of periodRefs) {
      if (p.id !== null) ordinalByPeriodId.set(p.id, p.ordinal);
    }
    const rows = await getLineupsForTeams(db, teams.map((t) => t.id));
    for (const row of rows) {
      const list = lineupsByTeam.get(row.fantasyTeamId) ?? [];
      list.push(row);
      lineupsByTeam.set(row.fantasyTeamId, list);
    }
    // "Featured" = played minutes in a fixture of the period (drives the
    // captain -> vice promotion).
    for (const st of stats) {
      if (st.minutesPlayed <= 0) continue;
      const ord = ordinalByFixtureId.get(st.fixtureId);
      if (ord === undefined) continue;
      const set = featuredByOrdinal.get(ord) ?? new Set<number>();
      set.add(st.playerId);
      featuredByOrdinal.set(ord, set);
    }
  }

  // --- chips overlay inputs (loaded ONLY when the chips flag is on; a
  // league without the flag computes the exact pre-chips numbers) ------------
  const chipsEnabled = await isFlagEnabled(db, leagueId, "chips");
  const chipByTeamOrdinal = new Map<number, Map<number, ChipType>>();
  const captainByTeamOrdinal = new Map<number, Map<number, number>>();
  if (chipsEnabled) {
    for (const p of periodRefs) {
      if (p.id !== null) ordinalByPeriodId.set(p.id, p.ordinal);
    }
    const plays = await db
      .select()
      .from(chipPlay)
      .where(eq(chipPlay.leagueId, leagueId));
    for (const c of plays) {
      const ord = ordinalByPeriodId.get(c.scoringPeriodId);
      if (ord === undefined) continue;
      const m = chipByTeamOrdinal.get(c.fantasyTeamId) ?? new Map<number, ChipType>();
      m.set(ord, c.chip);
      chipByTeamOrdinal.set(c.fantasyTeamId, m);
    }
    if (!isSetLineup) {
      const caps = await db
        .select()
        .from(periodCaptain)
        .where(inArray(periodCaptain.fantasyTeamId, teams.map((t) => t.id)));
      for (const c of caps) {
        const ord = ordinalByPeriodId.get(c.scoringPeriodId);
        if (ord === undefined) continue;
        const m = captainByTeamOrdinal.get(c.fantasyTeamId) ?? new Map<number, number>();
        m.set(ord, c.playerId);
        captainByTeamOrdinal.set(c.fantasyTeamId, m);
      }
    }
  }

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
    for (const period of periodRefs) {
      const stage = (period.stageCode ?? period.label) as Stage;

      // The roster the team actually had during this period (identical to
      // the current roster when the transactions flag is off).
      const periodRosterIds = txnsEnabled
        ? rosterAtOrdinal(rosterPlayerIds, team.id, ledger, period.ordinal)
        : rosterPlayerIds;

      if (isSetLineup) {
        // Submitted XI (rolled forward), captain doubled, vice promoted.
        const effective = effectiveLineupForOrdinal(
          lineupsByTeam.get(team.id) ?? [],
          ordinalByPeriodId,
          period.ordinal,
        );
        const periodRosterSet = new Set(periodRosterIds);
        const slotByPlayerId = new Map<number, SetLineupSlotInput>();
        for (const pid of (effective?.playerIds as number[] | undefined) ?? []) {
          const p = playerById.get(pid);
          // A player who left the roster before this period (transactions
          // flag) scores 0 even if a stale lineup still names him.
          const pts = periodRosterSet.has(pid)
            ? sumPlayerPointsInPeriod(pid, period.ordinal, scoreByKey, ordinalByFixtureId)
            : 0;
          slotByPlayerId.set(pid, {
            position: (p?.position ?? "MID") as Position,
            fullName: p?.fullName ?? `#${pid}`,
            points: pts,
          });
        }
        const chip = chipsEnabled
          ? (chipByTeamOrdinal.get(team.id)?.get(period.ordinal) ?? null)
          : null;
        let benchSlots: Map<number, SetLineupSlotInput> | undefined;
        if (chip === "BENCH_BOOST" && effective) {
          const xiSet = new Set(effective.playerIds as number[]);
          benchSlots = new Map();
          for (const pid of periodRosterIds) {
            if (xiSet.has(pid)) continue;
            const p = playerById.get(pid);
            benchSlots.set(pid, {
              position: (p?.position ?? "MID") as Position,
              fullName: p?.fullName ?? `#${pid}`,
              points: sumPlayerPointsInPeriod(pid, period.ordinal, scoreByKey, ordinalByFixtureId),
            });
          }
        }
        const result = scoreSetLineupPeriod(
          effective,
          slotByPlayerId,
          featuredByOrdinal.get(period.ordinal) ?? new Set<number>(),
          {
            captainMultiplier: chip === "TRIPLE_CAPTAIN" ? 3 : 2,
            ...(benchSlots ? { benchSlots } : {}),
          },
        );
        const periodPoints =
          chip === "STAGE_BOOST" ? round2(result.points * 2) : result.points;
        total += periodPoints;
        periods.push({
          stage,
          formation: result.formation,
          points: periodPoints,
          xi: result.xi,
        });
        continue;
      }

      const chip = chipsEnabled
        ? (chipByTeamOrdinal.get(team.id)?.get(period.ordinal) ?? null)
        : null;
      const captainId = chipsEnabled
        ? (captainByTeamOrdinal.get(team.id)?.get(period.ordinal) ?? null)
        : null;
      const captainMult = chip === "TRIPLE_CAPTAIN" ? 3 : 2;
      const scored: ScoredPlayer[] = periodRosterIds.map((pid) => {
        const p = playerById.get(pid);
        const raw = sumPlayerPointsInPeriod(
          pid,
          period.ordinal,
          scoreByKey,
          ordinalByFixtureId,
        );
        // Captain overlay (chips flag only): scale BEFORE optimizing so the
        // optimizer can prefer fielding the captain.
        const points = pid === captainId ? round2(raw * captainMult) : raw;
        return {
          playerId: pid,
          position: (p?.position ?? "MID") as Position,
          points,
        };
      });
      // Best-ball needs a complete legal roster; skip the optimizer for an
      // incomplete one (period contributes 0) rather than throwing.
      // BENCH_BOOST scores the whole roster instead of the optimal XI.
      const result =
        chip === "BENCH_BOOST"
          ? allRosterResult(scored)
          : canFieldXi(scored)
            ? optimizeBestBall(scored)
            : { formation: LEGAL_NONE, xi: [], points: 0 };
      const periodPoints =
        chip === "STAGE_BOOST" ? round2(result.points * 2) : result.points;
      total += periodPoints;
      periods.push({
        stage,
        formation:
          chip === "BENCH_BOOST"
            ? "ALL"
            : result.xi.length > 0
              ? formationLabel(result.formation)
              : "-",
        points: periodPoints,
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

/** Round to 2dp - keeps overlay totals consistent with the scoring engine. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** BENCH_BOOST: every rostered player scores (points-desc for display). */
function allRosterResult(scored: readonly ScoredPlayer[]): {
  formation: typeof LEGAL_NONE;
  xi: ScoredPlayer[];
  points: number;
} {
  const xi = [...scored].sort(
    (a, b) => b.points - a.points || a.playerId - b.playerId,
  );
  return {
    formation: LEGAL_NONE,
    xi,
    points: round2(xi.reduce((sum, p) => sum + p.points, 0)),
  };
}

function sumPlayerPointsInPeriod(
  playerId: number,
  ordinal: number,
  scoreByKey: Map<string, number>,
  ordinalByFixtureId: Map<number, number>,
): number {
  let sum = 0;
  for (const [fixtureId, fxOrdinal] of ordinalByFixtureId) {
    if (fxOrdinal !== ordinal) continue;
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
