/**
 * Pure scoring function.
 *
 * scoreStatLine(stat, position, ruleset) is a deterministic function of its
 * three inputs and must remain pure: no I/O, no time-of-day, no provider
 * lookups. That property is what makes the engine "recomputable" - rebuild
 * the score_entry table from stat_line + ruleset at any time and you get
 * the same answer.
 *
 * Edge cases enforced here come from section 5.2 of the project plan:
 *
 *   - Clean sheet: requires (minutes_played >= ruleset.cleanSheetMinMinutes)
 *     AND (team_conceded_in_regulation_and_et == 0). A defender subbed off
 *     at 55' does NOT earn it. A player sent off before the minute
 *     threshold does NOT earn it (their minutes_played reflects the early
 *     dismissal).
 *
 *   - Penalty shootout goals are NOT counted. This is already enforced at
 *     the stat_line layer: the goals counter excludes shootout goals.
 *
 *   - Extra-time stats count normally. Already handled by stat_line.
 *
 *   - Cards are scored per type, not escalating. Two yellows + a red
 *     therefore score 2*(-1) + 1*(-3) = -5. That matches the provider's
 *     usual representation of a second-yellow dismissal.
 *
 * The return value carries a per-rule breakdown alongside the total. The
 * breakdown is what makes "why did this player get 7 points?" answerable
 * later in the UI without re-running the function on a different machine.
 */

import type { Position, StatLineRow } from "../db/schema.js";
import type { ScoringRuleset } from "./ruleset.js";

export interface ScoreBreakdown {
  appearance: number;
  played60Plus: number;
  goals: number;
  assists: number;
  saves: number;
  cleanSheet: number;
  penaltiesSaved: number;
  penaltiesMissed: number;
  ownGoals: number;
  yellowCards: number;
  redCards: number;
}

export interface ScoredResult {
  /** Sum of all breakdown components. */
  points: number;
  breakdown: ScoreBreakdown;
}

/**
 * Subset of stat_line needed for scoring. Accepting this shape (rather
 * than the full Drizzle row) keeps the function trivially callable from
 * tests with object literals.
 */
export type ScorableStatLine = Pick<
  StatLineRow,
  | "minutesPlayed"
  | "goals"
  | "assists"
  | "saves"
  | "yellowCards"
  | "redCards"
  | "penaltiesScored"
  | "penaltiesMissed"
  | "penaltiesSaved"
  | "ownGoals"
  | "teamConcededInRegulationAndEt"
>;

export function scoreStatLine(
  stat: ScorableStatLine,
  position: Position,
  ruleset: ScoringRuleset,
): ScoredResult {
  const breakdown: ScoreBreakdown = {
    appearance: 0,
    played60Plus: 0,
    goals: 0,
    assists: 0,
    saves: 0,
    cleanSheet: 0,
    penaltiesSaved: 0,
    penaltiesMissed: 0,
    ownGoals: 0,
    yellowCards: 0,
    redCards: 0,
  };

  // A player who never came on the pitch scores 0 across the board. This
  // matches "Appearance (played any minutes) +1" - no minutes, no point.
  if (stat.minutesPlayed <= 0) {
    return { points: 0, breakdown };
  }

  breakdown.appearance = ruleset.appearance;

  if (stat.minutesPlayed >= 60) {
    breakdown.played60Plus = ruleset.played60Plus;
  }

  // Per-position goal values. Penalty *shootout* goals are excluded at the
  // stat_line layer; open-play penalty conversions are included in `goals`
  // (and earn the position's standard goal value, per the plan).
  const goalValue = ruleset.goalByPosition[position] ?? 0;
  breakdown.goals = stat.goals * goalValue;

  breakdown.assists = stat.assists * ruleset.assist;
  breakdown.saves = stat.saves * ruleset.save;

  // Clean sheet eligibility:
  //   1. Player on the pitch long enough.
  //   2. Team conceded 0 in regulation + ET.
  //   3. Position earns the bonus (GK / DEF only).
  const cleanSheetValue = ruleset.cleanSheetByPosition[position];
  if (
    cleanSheetValue !== undefined &&
    stat.minutesPlayed >= ruleset.cleanSheetMinMinutes &&
    stat.teamConcededInRegulationAndEt === 0
  ) {
    breakdown.cleanSheet = cleanSheetValue;
  }

  breakdown.penaltiesSaved = stat.penaltiesSaved * ruleset.penaltySaved;
  breakdown.penaltiesMissed = stat.penaltiesMissed * ruleset.penaltyMissed;
  breakdown.ownGoals = stat.ownGoals * ruleset.ownGoal;
  breakdown.yellowCards = stat.yellowCards * ruleset.yellowCard;
  breakdown.redCards = stat.redCards * ruleset.redCard;

  const points =
    breakdown.appearance +
    breakdown.played60Plus +
    breakdown.goals +
    breakdown.assists +
    breakdown.saves +
    breakdown.cleanSheet +
    breakdown.penaltiesSaved +
    breakdown.penaltiesMissed +
    breakdown.ownGoals +
    breakdown.yellowCards +
    breakdown.redCards;

  return { points, breakdown };
}
