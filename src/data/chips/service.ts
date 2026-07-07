/**
 * Chips + per-period captain service (Phase 9 Priority 3).
 *
 * Selections here are pure INTENT rows; their effect is applied as a
 * read-time overlay inside computeStandings (never to score_entry).
 *
 * Rules (phase-06, adapted to scoring periods):
 *   - Everything is gated by the `chips` feature flag.
 *   - Selections lock at the period's first kickoff (same rule and fixture
 *     matching as lineups).
 *   - period_captain is the BEST_BALL captain layer (x2, x3 with
 *     TRIPLE_CAPTAIN). SET_LINEUP leagues set their captain on the lineup,
 *     so setPeriodCaptain rejects them (CAPTAIN_VIA_LINEUP).
 *   - Each chip once per tournament; chips never stack on one period.
 *   - TRIPLE_CAPTAIN requires a captain to exist for that period (a
 *     period_captain row for best-ball; any effective - submitted or
 *     rolled-forward - lineup for set-lineup).
 *
 * Pure service: takes a Db and plain inputs; no HTTP/auth/env here.
 */
import { and, eq } from "drizzle-orm";

import type { PeriodRef } from "../competition/periods.js";
import type { Db } from "../db/client.js";
import {
  chipPlay,
  chipTypeEnum,
  fantasyTeam,
  league,
  lineup,
  periodCaptain,
  rosterSlot,
  scoringPeriod,
  type ChipPlayRow,
  type ChipType,
  type FantasyTeamRow,
  type LeagueRow,
  type PeriodCaptainRow,
} from "../db/schema.js";
import { isFlagEnabled } from "../league/feature-flags.js";
import { periodFirstKickoff } from "../lineup/service.js";
import { ChipsError } from "./errors.js";

export const ALL_CHIPS: readonly ChipType[] = chipTypeEnum.enumValues;

interface ResolvedContext {
  team: FantasyTeamRow;
  lg: LeagueRow;
  period: PeriodRef;
}

/** Shared team/league/flag/period/lock resolution. */
async function resolve(
  db: Db,
  fantasyTeamId: number,
  scoringPeriodId: number,
  now: Date,
): Promise<ResolvedContext> {
  const [team] = await db
    .select()
    .from(fantasyTeam)
    .where(eq(fantasyTeam.id, fantasyTeamId));
  if (!team) {
    throw new ChipsError(`fantasy team ${fantasyTeamId} does not exist`, "TEAM_NOT_FOUND");
  }
  const [lg] = await db.select().from(league).where(eq(league.id, team.leagueId));
  if (!lg) throw new ChipsError(`league ${team.leagueId} does not exist`, "LEAGUE_NOT_FOUND");
  if (!(await isFlagEnabled(db, lg.id, "chips"))) {
    throw new ChipsError(
      `league ${lg.id} does not have the chips flag enabled`,
      "CHIPS_FLAG_DISABLED",
    );
  }
  const [row] = await db
    .select()
    .from(scoringPeriod)
    .where(eq(scoringPeriod.id, scoringPeriodId));
  if (!row) {
    throw new ChipsError(`scoring period ${scoringPeriodId} does not exist`, "PERIOD_NOT_FOUND");
  }
  if (lg.competitionId === null || row.competitionId !== lg.competitionId) {
    throw new ChipsError(
      `scoring period ${row.id} is not part of league ${lg.id}'s competition`,
      "PERIOD_NOT_IN_COMPETITION",
    );
  }
  const period: PeriodRef = {
    id: row.id,
    ordinal: row.ordinal,
    label: row.label,
    stageCode: row.stageCode,
  };
  const firstKickoff = await periodFirstKickoff(db, period);
  if (firstKickoff !== null && now >= firstKickoff) {
    throw new ChipsError(
      `selections for ${row.label} locked at first kickoff (${firstKickoff.toISOString()})`,
      "SELECTION_LOCKED",
    );
  }
  return { team, lg, period };
}

export interface SetPeriodCaptainInput {
  fantasyTeamId: number;
  scoringPeriodId: number;
  playerId: number;
  now?: Date;
}

/**
 * Nominate (or change) a best-ball team's captain for one period. The
 * captain's period points are doubled (tripled under TRIPLE_CAPTAIN) in
 * the standings overlay.
 */
export async function setPeriodCaptain(
  db: Db,
  input: SetPeriodCaptainInput,
): Promise<PeriodCaptainRow> {
  const now = input.now ?? new Date();
  const { team, lg } = await resolve(db, input.fantasyTeamId, input.scoringPeriodId, now);
  if (lg.format === "SET_LINEUP") {
    throw new ChipsError(
      "SET_LINEUP leagues pick their captain on the lineup, not here",
      "CAPTAIN_VIA_LINEUP",
    );
  }
  const [slot] = await db
    .select()
    .from(rosterSlot)
    .where(
      and(
        eq(rosterSlot.fantasyTeamId, team.id),
        eq(rosterSlot.playerId, input.playerId),
      ),
    );
  if (!slot) {
    throw new ChipsError(
      `player ${input.playerId} is not on this team's roster`,
      "PLAYER_NOT_ON_ROSTER",
    );
  }
  const [row] = await db
    .insert(periodCaptain)
    .values({
      fantasyTeamId: team.id,
      scoringPeriodId: input.scoringPeriodId,
      playerId: input.playerId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [periodCaptain.fantasyTeamId, periodCaptain.scoringPeriodId],
      set: { playerId: input.playerId, updatedAt: now },
    })
    .returning();
  if (!row) throw new ChipsError("captain upsert failed", "CAPTAIN_UPSERT_FAILED");
  return row;
}

export interface PlayChipInput {
  fantasyTeamId: number;
  scoringPeriodId: number;
  chip: ChipType;
  now?: Date;
}

/** Spend a chip on a period. One use per chip; no stacking on a period. */
export async function playChip(db: Db, input: PlayChipInput): Promise<ChipPlayRow> {
  const now = input.now ?? new Date();
  const { team, lg, period } = await resolve(
    db,
    input.fantasyTeamId,
    input.scoringPeriodId,
    now,
  );

  const played = await db
    .select()
    .from(chipPlay)
    .where(
      and(eq(chipPlay.leagueId, lg.id), eq(chipPlay.fantasyTeamId, team.id)),
    );
  if (played.some((p) => p.chip === input.chip)) {
    throw new ChipsError(`${input.chip} has already been used`, "CHIP_ALREADY_USED");
  }
  if (played.some((p) => p.scoringPeriodId === input.scoringPeriodId)) {
    throw new ChipsError(
      `a chip is already committed to ${period.label}; chips do not stack`,
      "CHIP_PERIOD_TAKEN",
    );
  }

  if (input.chip === "TRIPLE_CAPTAIN") {
    if (lg.format === "SET_LINEUP") {
      const rows = await db
        .select({ ordinal: scoringPeriod.ordinal })
        .from(lineup)
        .innerJoin(scoringPeriod, eq(scoringPeriod.id, lineup.scoringPeriodId))
        .where(eq(lineup.fantasyTeamId, team.id));
      const hasEffective = rows.some((r) => r.ordinal <= period.ordinal);
      if (!hasEffective) {
        throw new ChipsError(
          "TRIPLE_CAPTAIN needs a lineup (with its captain) covering that period",
          "TC_REQUIRES_CAPTAIN",
        );
      }
    } else {
      const [cap] = await db
        .select()
        .from(periodCaptain)
        .where(
          and(
            eq(periodCaptain.fantasyTeamId, team.id),
            eq(periodCaptain.scoringPeriodId, input.scoringPeriodId),
          ),
        );
      if (!cap) {
        throw new ChipsError(
          "TRIPLE_CAPTAIN needs a period captain set first",
          "TC_REQUIRES_CAPTAIN",
        );
      }
    }
  }

  const [row] = await db
    .insert(chipPlay)
    .values({
      leagueId: lg.id,
      fantasyTeamId: team.id,
      chip: input.chip,
      scoringPeriodId: input.scoringPeriodId,
    })
    .returning();
  if (!row) throw new ChipsError("chip insert failed", "CHIP_INSERT_FAILED");
  return row;
}

export interface ChipState {
  played: ChipPlayRow[];
  remaining: ChipType[];
  captains: PeriodCaptainRow[];
}

/** A team's chip/captain state (for the API/UI). */
export async function getChipState(db: Db, fantasyTeamId: number): Promise<ChipState> {
  const played = await db
    .select()
    .from(chipPlay)
    .where(eq(chipPlay.fantasyTeamId, fantasyTeamId));
  const captains = await db
    .select()
    .from(periodCaptain)
    .where(eq(periodCaptain.fantasyTeamId, fantasyTeamId));
  const used = new Set(played.map((p) => p.chip));
  return {
    played,
    remaining: ALL_CHIPS.filter((c) => !used.has(c)),
    captains,
  };
}
