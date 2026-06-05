/**
 * Pure projection function: given a player's shares, match odds, and the
 * scoring ruleset, compute expected fantasy points for a single fixture.
 *
 * minutesShare from PlayerShares is a rank-calibrated probability of
 * playing significant minutes. We use it directly as the appearance weight
 * and derive a 60+ minutes probability from it.
 */

import type { ScoringRuleset } from "../scoring/ruleset.js";
import type { PlayerShares } from "./player-shares.js";
import type { MatchOddsRow } from "../db/schema.js";

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
  const { expectedTotalGoals, homeCleanSheetP, awayCleanSheetP, homeWinP, awayWinP } = odds;
  const { goalShare, assistShare, minutesShare, position } = shares;

  // Per-team expected goals split by result probability bias.
  const bias = 0.5 * (homeWinP - awayWinP);
  const lambdaHome = Math.max(0.1, expectedTotalGoals * (0.5 + bias));
  const lambdaAway = Math.max(0.1, expectedTotalGoals - lambdaHome);
  const teamLambda = isHome ? lambdaHome : lambdaAway;
  const cleanSheetP = isHome ? homeCleanSheetP : awayCleanSheetP;

  // Appearance probabilities derived from minutesShare.
  // pAppears: slightly higher than minutesShare (late subs can still appear).
  const pAppears = Math.min(1, minutesShare + 0.05);

  // p60Plus: probability of playing 60+ minutes.
  // Starters (minutesShare >= 0.70) are very likely to play 60+.
  // Rotation players are less certain. Impact subs rarely hit 60.
  const p60Plus =
    minutesShare >= 0.70 ? minutesShare * 0.90 :
    minutesShare >= 0.30 ? minutesShare * 0.60 :
                           minutesShare * 0.20;

  let pts = 0;

  // Appearance points.
  pts += pAppears * ruleset.appearance;
  pts += p60Plus * ruleset.played60Plus;

  // Goals.
  pts += teamLambda * goalShare * ruleset.goalByPosition[position];

  // Assists.
  pts += teamLambda * assistShare * ruleset.assist;

  // Clean sheet bonus (GK and DEF only, must play 60+).
  const csBonus = ruleset.cleanSheetByPosition[position];
  if (csBonus !== undefined) {
    pts += p60Plus * cleanSheetP * csBonus;
  }

  return Math.max(0, pts);
}
