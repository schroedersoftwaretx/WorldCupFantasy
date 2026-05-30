/**
 * Pure projection function: given a player's shares, match odds, and the
 * scoring ruleset, compute expected fantasy points for a single fixture.
 *
 * This is intentionally a pure function — no DB, no I/O — so it's cheap to
 * test and call in a tight loop over hundreds of players.
 */

import type { ScoringRuleset } from "../scoring/ruleset.js";
import type { PlayerShares } from "./player-shares.js";
import type { MatchOddsRow } from "../db/schema.js";

/**
 * Compute projected fantasy points for one player in one fixture.
 *
 * @param shares       The player's contribution-share profile.
 * @param odds         The match odds row for this fixture.
 * @param isHome       Whether this player's team is the home side.
 * @param ruleset      The active scoring ruleset.
 */
export function projectPoints(
  shares: PlayerShares,
  odds: Pick<
    MatchOddsRow,
    | "expectedTotalGoals"
    | "homeCleanSheetP"
    | "awayCleanSheetP"
    | "homeWinP"
    | "awayWinP"
    | "drawP"
  >,
  isHome: boolean,
  ruleset: ScoringRuleset,
): number {
  const {
    expectedTotalGoals,
    homeCleanSheetP,
    awayCleanSheetP,
    homeWinP,
    awayWinP,
  } = odds;
  const { goalShare, assistShare, minutesShare, position } = shares;

  // --- Split expected goals by side (reuse same logic as odds-mapping) ---
  const bias = 0.5 * (homeWinP - awayWinP);
  const lambdaHome = Math.max(0.1, expectedTotalGoals * (0.5 + bias));
  const lambdaAway = Math.max(0.1, expectedTotalGoals - lambdaHome);
  const teamLambda = isHome ? lambdaHome : lambdaAway;
  const cleanSheetP = isHome ? homeCleanSheetP : awayCleanSheetP;

  // --- Appearance / minutes component ---
  // minutesShare is probability of appearing × expected minutes fraction.
  // appearance point: given any minutes
  // played60Plus: given 60+ minutes (we treat minutesShare > 0.67 as likely 60+)
  const pAppears = Math.min(1, minutesShare * 1.3); // slightly inflate share → appearance prob
  const p60Plus = Math.min(pAppears, minutesShare > 0.67 ? minutesShare * 0.9 : minutesShare * 0.5);

  let pts = 0;
  pts += pAppears * ruleset.appearance;
  pts += p60Plus * ruleset.played60Plus;

  // --- Goals ---
  // Expected goals by this player = team's expected goals × this player's goal share
  const expectedGoals = teamLambda * goalShare;
  pts += expectedGoals * ruleset.goalByPosition[position];

  // --- Assists ---
  const expectedAssists = teamLambda * assistShare;
  pts += expectedAssists * ruleset.assist;

  // --- Clean sheet bonus ---
  const csBonus = ruleset.cleanSheetByPosition[position];
  if (csBonus !== undefined) {
    // Must play 60+ minutes. Use p60Plus as proxy.
    pts += p60Plus * cleanSheetP * csBonus;
  }

  // --- GK saves ---
  // No per-player save data from football-data.org; skip for now.
  // If API-Football data is present in stat_lines, we could estimate from history.

  // Note: yellow/red cards and own goals have very low base rates and are
  // negative events — we don't project them (keeps projections positive and
  // interpretable, and their expected value is small).

  return Math.max(0, pts);
}
