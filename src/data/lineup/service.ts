/**
 * Lineup service (Phase 9 Priority 1, SET_LINEUP format).
 *
 * A SET_LINEUP league's manager submits a starting XI (+ captain / optional
 * vice-captain) per scoring period, instead of the retroactive best-ball
 * optimizer. This service owns submission: legality (a legal formation of 11
 * distinct rostered players; captain and vice in the XI), the lock at the
 * period's first kickoff, and the upsert. Reading lineups for SCORING lives
 * in src/data/standings/set-lineup.ts.
 *
 * Best-ball leagues never reach this service (format guard throws), so the
 * running leagues are untouched.
 *
 * Pure service: takes a Db and plain inputs; no HTTP/auth/env here.
 */
import { asc, eq, inArray } from "drizzle-orm";

import { assignFixturesToPeriods, type PeriodRef } from "../competition/periods.js";
import type { Db, DbTx } from "../db/client.js";
import {
  fantasyTeam,
  fixture,
  league,
  lineup,
  player,
  rosterSlot,
  scoringPeriod,
  type LineupRow,
  type Position,
} from "../db/schema.js";
import { LEGAL_FORMATIONS, type XiFormation } from "../standings/lineup.js";
import { LineupError } from "./errors.js";

export const XI_SIZE = 11;

export interface SubmitLineupInput {
  fantasyTeamId: number;
  scoringPeriodId: number;
  /** Exactly 11 distinct rostered player ids. */
  playerIds: number[];
  captainPlayerId: number;
  viceCaptainPlayerId?: number | null;
  /** Injectable clock for tests; defaults to new Date(). */
  now?: Date;
}

/**
 * Validate an XI selection against the roster - pure. Returns the formation
 * the XI forms. Throws LineupError on any violation.
 */
export function validateLineupSelection(
  positionByPlayerId: ReadonlyMap<number, Position>,
  playerIds: readonly number[],
  captainPlayerId: number,
  viceCaptainPlayerId: number | null,
): XiFormation {
  if (playerIds.length !== XI_SIZE) {
    throw new LineupError(
      `a lineup must name exactly ${XI_SIZE} players (got ${playerIds.length})`,
      "LINEUP_SIZE",
    );
  }
  if (new Set(playerIds).size !== XI_SIZE) {
    throw new LineupError("a lineup must not repeat a player", "LINEUP_DUPLICATE_PLAYER");
  }
  const counts: Record<Position, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const pid of playerIds) {
    const pos = positionByPlayerId.get(pid);
    if (!pos) {
      throw new LineupError(
        `player ${pid} is not on this team's roster`,
        "PLAYER_NOT_ON_ROSTER",
      );
    }
    counts[pos] += 1;
  }
  const formation = LEGAL_FORMATIONS.find(
    (f) =>
      counts.GK === f.GK &&
      counts.DEF === f.DEF &&
      counts.MID === f.MID &&
      counts.FWD === f.FWD,
  );
  if (!formation) {
    throw new LineupError(
      `illegal formation ${counts.GK}GK ${counts.DEF}-${counts.MID}-${counts.FWD}; ` +
        "legal: 1 GK with DEF 4-5, MID 2-4, FWD 2-3",
      "ILLEGAL_FORMATION",
    );
  }
  if (!playerIds.includes(captainPlayerId)) {
    throw new LineupError("the captain must be in the XI", "CAPTAIN_NOT_IN_XI");
  }
  if (viceCaptainPlayerId !== null) {
    if (viceCaptainPlayerId === captainPlayerId) {
      throw new LineupError(
        "the vice-captain must differ from the captain",
        "VICE_IS_CAPTAIN",
      );
    }
    if (!playerIds.includes(viceCaptainPlayerId)) {
      throw new LineupError("the vice-captain must be in the XI", "VICE_NOT_IN_XI");
    }
  }
  return formation;
}

/**
 * The period's first kickoff - the submission lock. Fixtures are matched to
 * the period the same way scoring matches them (scoring_period_id first,
 * stage_code fallback). Null when the period has no fixtures yet (unlocked).
 */
export async function periodFirstKickoff(
  db: Db | DbTx,
  period: PeriodRef,
): Promise<Date | null> {
  const fixtures = await db.select().from(fixture);
  const assigned = assignFixturesToPeriods([period], fixtures);
  let first: Date | null = null;
  for (const f of fixtures) {
    if (!assigned.has(f.id)) continue;
    if (first === null || f.kickoffUtc < first) first = f.kickoffUtc;
  }
  return first;
}

/**
 * Submit (or replace) a team's lineup for a scoring period. Idempotent on
 * the (fantasy_team_id, scoring_period_id) PK. Enforces:
 *   - the league's format is SET_LINEUP
 *   - the period belongs to the league's competition
 *   - the period has not locked (first kickoff in the future)
 *   - the XI is a legal formation of 11 distinct rostered players, with
 *     captain (and vice, if given) in the XI
 */
export async function submitLineup(
  db: Db,
  input: SubmitLineupInput,
): Promise<LineupRow> {
  const now = input.now ?? new Date();

  const [team] = await db
    .select()
    .from(fantasyTeam)
    .where(eq(fantasyTeam.id, input.fantasyTeamId));
  if (!team) {
    throw new LineupError(
      `fantasy team ${input.fantasyTeamId} does not exist`,
      "TEAM_NOT_FOUND",
    );
  }
  const [lg] = await db.select().from(league).where(eq(league.id, team.leagueId));
  if (!lg) {
    throw new LineupError(`league ${team.leagueId} does not exist`, "LEAGUE_NOT_FOUND");
  }
  if (lg.format !== "SET_LINEUP") {
    throw new LineupError(
      `league ${lg.id} is ${lg.format}; lineups apply only to SET_LINEUP leagues`,
      "FORMAT_NOT_SET_LINEUP",
    );
  }

  const [period] = await db
    .select()
    .from(scoringPeriod)
    .where(eq(scoringPeriod.id, input.scoringPeriodId));
  if (!period) {
    throw new LineupError(
      `scoring period ${input.scoringPeriodId} does not exist`,
      "PERIOD_NOT_FOUND",
    );
  }
  if (lg.competitionId === null || period.competitionId !== lg.competitionId) {
    throw new LineupError(
      `scoring period ${period.id} is not part of league ${lg.id}'s competition`,
      "PERIOD_NOT_IN_COMPETITION",
    );
  }

  const ref: PeriodRef = {
    id: period.id,
    ordinal: period.ordinal,
    label: period.label,
    stageCode: period.stageCode,
  };
  const firstKickoff = await periodFirstKickoff(db, ref);
  if (firstKickoff !== null && now >= firstKickoff) {
    throw new LineupError(
      `lineups for ${period.label} locked at first kickoff (${firstKickoff.toISOString()})`,
      "LINEUP_LOCKED",
    );
  }

  // Roster positions (player.position - the same source scoring uses).
  const slots = await db
    .select({ playerId: rosterSlot.playerId, position: player.position })
    .from(rosterSlot)
    .innerJoin(player, eq(player.id, rosterSlot.playerId))
    .where(eq(rosterSlot.fantasyTeamId, team.id));
  const positionByPlayerId = new Map(slots.map((s) => [s.playerId, s.position]));

  validateLineupSelection(
    positionByPlayerId,
    input.playerIds,
    input.captainPlayerId,
    input.viceCaptainPlayerId ?? null,
  );

  const [row] = await db
    .insert(lineup)
    .values({
      fantasyTeamId: team.id,
      scoringPeriodId: period.id,
      playerIds: input.playerIds,
      captainPlayerId: input.captainPlayerId,
      viceCaptainPlayerId: input.viceCaptainPlayerId ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [lineup.fantasyTeamId, lineup.scoringPeriodId],
      set: {
        playerIds: input.playerIds,
        captainPlayerId: input.captainPlayerId,
        viceCaptainPlayerId: input.viceCaptainPlayerId ?? null,
        updatedAt: now,
      },
    })
    .returning();
  if (!row) throw new LineupError("lineup upsert failed", "LINEUP_UPSERT_FAILED");
  return row;
}

/** All lineup rows for a set of teams (one bulk query for scoring). */
export async function getLineupsForTeams(
  db: Db | DbTx,
  fantasyTeamIds: readonly number[],
): Promise<LineupRow[]> {
  if (fantasyTeamIds.length === 0) return [];
  return db
    .select()
    .from(lineup)
    .where(inArray(lineup.fantasyTeamId, [...fantasyTeamIds]));
}

/** One team's lineups, ordered by period ordinal (for the API/UI). */
export async function getLineups(
  db: Db | DbTx,
  fantasyTeamId: number,
): Promise<Array<LineupRow & { ordinal: number; label: string }>> {
  return db
    .select({
      fantasyTeamId: lineup.fantasyTeamId,
      scoringPeriodId: lineup.scoringPeriodId,
      playerIds: lineup.playerIds,
      captainPlayerId: lineup.captainPlayerId,
      viceCaptainPlayerId: lineup.viceCaptainPlayerId,
      createdAt: lineup.createdAt,
      updatedAt: lineup.updatedAt,
      ordinal: scoringPeriod.ordinal,
      label: scoringPeriod.label,
    })
    .from(lineup)
    .innerJoin(scoringPeriod, eq(scoringPeriod.id, lineup.scoringPeriodId))
    .where(eq(lineup.fantasyTeamId, fantasyTeamId))
    .orderBy(asc(scoringPeriod.ordinal));
}

/**
 * Roll-forward: the effective lineup for a target period is the submitted
 * row with the greatest ordinal <= the target's ordinal (FPL-style "your
 * team carries over"). Pure - exported for unit tests and the scorer.
 */
export function effectiveLineupForOrdinal(
  rows: readonly LineupRow[],
  ordinalByPeriodId: ReadonlyMap<number, number>,
  targetOrdinal: number,
): LineupRow | null {
  let best: LineupRow | null = null;
  let bestOrdinal = -Infinity;
  for (const row of rows) {
    const ord = ordinalByPeriodId.get(row.scoringPeriodId);
    if (ord === undefined || ord > targetOrdinal) continue;
    if (ord > bestOrdinal) {
      best = row;
      bestOrdinal = ord;
    }
  }
  return best;
}
