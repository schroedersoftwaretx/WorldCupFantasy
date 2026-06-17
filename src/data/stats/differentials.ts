/**
 * Per-team differentials & value (Phase 2.3).
 *
 * For ONE fantasy team, annotate each of its rostered players with the
 * cross-league context built in this phase and bucket them:
 *   - differentials: low global ownership but scoring well (a contrarian edge)
 *   - template:      high global ownership (the players "everyone" has)
 *   - bestValue:     most fantasy points per the slot they were drafted at
 *                    (pointsTotal / ADP)
 *
 * Privacy/fairness (acceptance-critical): this service is intentionally scoped
 * to a SINGLE team's own roster. It returns only that team's players; the
 * ownership/ADP context it layers on is pure cross-league AGGREGATE
 * (counts/percentages), so it never reveals which rival team in another league
 * rosters a given player.
 *
 * Pure read. Points come from score_entry for the supplied ruleset version
 * (passed in by the caller; never hard-coded here) so it stays consistent with
 * the rest of the stats surfaces.
 */
import { and, eq, inArray } from "drizzle-orm";

import type { Db, DbTx } from "../db/client.js";
import { fantasyTeam, rosterSlot, scoreEntry } from "../db/schema.js";
import { loadRefs, type PlayerRef } from "./aggregate.js";
import { adpByPlayerId } from "./adp.js";
import { ownershipByPlayerId, type OwnershipOptions } from "./ownership.js";

export interface TeamInsightsQuery {
  leagueId: number;
  teamId: number;
  /** Ruleset version to total score_entry points against (caller-derived). */
  rulesetVersion: string;
  /**
   * Ownership cutoff in [0,1] separating "differential" (strictly below) from
   * "template" (at or above). Default 0.5 (50%).
   */
  templateThreshold?: number;
  /** How many players to surface in each bucket. Default 5. */
  limit?: number;
  /** Scope ownership to finished-draft leagues. Default true. */
  finishedDraftsOnly?: boolean;
}

/** One rostered player annotated with ownership / ADP / value. */
export interface RosterInsightPlayer extends PlayerRef {
  draftRank: number | null;
  ownedCount: number;
  ownershipPct: number;
  /** Total fantasy points (score_entry) for the ruleset, 2dp. */
  pointsTotal: number;
  /** Cross-league average draft position, or null if never drafted. */
  adp: number | null;
  /** pointsTotal / adp when adp present and > 0, else null. 2dp. */
  valuePerAdp: number | null;
}

export interface TeamInsights {
  leagueId: number;
  teamId: number;
  /** Ownership denominator (fantasy teams in eligible leagues). */
  totalFantasyTeams: number;
  templateThreshold: number;
  /** Every player on the team, annotated, sorted by points desc. */
  players: RosterInsightPlayer[];
  /** Low-owned, positive-scoring players (the team's contrarian edges). */
  differentials: RosterInsightPlayer[];
  /** High-owned players (the "template" core). */
  template: RosterInsightPlayer[];
  /** Best points-per-ADP (steals of the draft). */
  bestValue: RosterInsightPlayer[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Build the differentials / template / best-value view for one fantasy team.
 * Throws if the team does not exist or does not belong to the league (so a
 * caller can never accidentally surface another league's team).
 */
export async function teamInsights(
  db: Db | DbTx,
  query: TeamInsightsQuery,
): Promise<TeamInsights> {
  const templateThreshold = query.templateThreshold ?? 0.5;
  const limit = query.limit ?? 5;

  const [team] = await db
    .select()
    .from(fantasyTeam)
    .where(eq(fantasyTeam.id, query.teamId));
  if (!team || team.leagueId !== query.leagueId) {
    throw new Error(
      `team ${query.teamId} not found in league ${query.leagueId}`,
    );
  }

  // This team's roster only.
  const slots = await db
    .select({ playerId: rosterSlot.playerId })
    .from(rosterSlot)
    .where(eq(rosterSlot.fantasyTeamId, query.teamId));
  const playerIds = slots.map((s) => s.playerId);

  if (playerIds.length === 0) {
    return {
      leagueId: query.leagueId,
      teamId: query.teamId,
      totalFantasyTeams: 0,
      templateThreshold,
      players: [],
      differentials: [],
      template: [],
      bestValue: [],
    };
  }

  const ownershipOptions: OwnershipOptions = {
    ...(query.finishedDraftsOnly !== undefined
      ? { finishedDraftsOnly: query.finishedDraftsOnly }
      : {}),
  };
  const [refs, ownership, adp, scores] = await Promise.all([
    loadRefs(db, playerIds),
    ownershipByPlayerId(db, ownershipOptions),
    adpByPlayerId(db, {}),
    db
      .select({ playerId: scoreEntry.playerId, points: scoreEntry.points })
      .from(scoreEntry)
      .where(
        and(
          eq(scoreEntry.rulesetVersion, query.rulesetVersion),
          inArray(scoreEntry.playerId, playerIds),
        ),
      ),
  ]);

  const pointsByPlayer = new Map<number, number>();
  for (const s of scores) {
    pointsByPlayer.set(s.playerId, (pointsByPlayer.get(s.playerId) ?? 0) + s.points);
  }

  const players: RosterInsightPlayer[] = [];
  for (const playerId of playerIds) {
    const ref = refs.get(playerId);
    if (!ref) continue;
    const own = ownership.byPlayerId.get(playerId);
    const a = adp.byPlayerId.get(playerId);
    const pointsTotal = round2(pointsByPlayer.get(playerId) ?? 0);
    const adpValue = a?.adp ?? null;
    const valuePerAdp =
      adpValue !== null && adpValue > 0 ? round2(pointsTotal / adpValue) : null;
    players.push({
      ...ref,
      draftRank: a?.draftRank ?? null,
      ownedCount: own?.ownedCount ?? 0,
      ownershipPct: own?.ownershipPct ?? 0,
      pointsTotal,
      adp: adpValue,
      valuePerAdp,
    });
  }

  players.sort(
    (a, b) => b.pointsTotal - a.pointsTotal || a.playerId - b.playerId,
  );

  const differentials = players
    .filter((p) => p.ownershipPct < templateThreshold && p.pointsTotal > 0)
    .sort(
      (a, b) =>
        b.pointsTotal - a.pointsTotal ||
        a.ownershipPct - b.ownershipPct ||
        a.playerId - b.playerId,
    )
    .slice(0, limit);

  const template = players
    .filter((p) => p.ownershipPct >= templateThreshold)
    .sort(
      (a, b) =>
        b.ownershipPct - a.ownershipPct ||
        b.pointsTotal - a.pointsTotal ||
        a.playerId - b.playerId,
    )
    .slice(0, limit);

  const bestValue = players
    .filter((p) => p.valuePerAdp !== null)
    .sort(
      (a, b) =>
        (b.valuePerAdp ?? 0) - (a.valuePerAdp ?? 0) || a.playerId - b.playerId,
    )
    .slice(0, limit);

  return {
    leagueId: query.leagueId,
    teamId: query.teamId,
    totalFantasyTeams: ownership.totalFantasyTeams,
    templateThreshold,
    players,
    differentials,
    template,
    bestValue,
  };
}
