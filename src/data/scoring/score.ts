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
  // Detailed-action rules (v2). Default 0 when the provider lacks the data.
  shotsOnTarget: number;
  shotsOffTarget: number;
  tacklesSuccessful: number;
  crosses: number;
  passesCompleted: number;
  /** Playmaking: each key pass (a pass leading to a shot). */
  keyPasses: number;
  /** Playmaking: each big chance created. */
  bigChancesCreated: number;
  /** GK-only: goals conceded penalty. */
  goalsConcededByKeeper: number;
  /** GK-only: flat win bonus. */
  gameWon: number;
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
  | "shotsOnTarget"
  | "shotsOffTarget"
  | "tacklesSuccessful"
  | "crosses"
  | "passesCompleted"
  | "keyPasses"
  | "bigChancesCreated"
  | "goalsConceded"
  | "teamScoredInRegulationAndEt"
>;

/**
 * Round to 2 decimal places to keep fractional rules (0.5, 0.05) free of
 * binary-float drift, e.g. 0.05 * 41 = 2.0500000000000003 -> 2.05. Every
 * rule value is a multiple of 0.05, so 2dp is exact for any legal total.
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Resolve the overlap between assists, big chances created, and key passes
 * into the counts that actually earn points, so one action is paid once.
 *
 * The three SofaScore/Opta metrics overlap by design: a big chance that is
 * converted is ALSO an assist, and an unconverted big chance that drew a shot
 * is ALSO a key pass. Priority is assist > big chance > key pass:
 *
 *   - Big chances that were converted (i.e. are among the assists) earn
 *     nothing extra — the assist already pays:
 *         effectiveBig = bigChancesCreated - assists
 *   - Of the remaining (non-assist) big chances, the ones that were also key
 *     passes earn the big-chance bonus only, not the key-pass value as well:
 *         effectiveKey = keyPasses - effectiveBig
 *
 * Both clamp at 0. We only have per-match totals (not which specific pass was
 * which), so this assumes maximal overlap — the most aggressive de-dup. It can
 * mildly under-count when a big chance produced no shot at all, which errs on
 * the side of never double-paying.
 */
export function effectivePlaymakingCounts(
  stat: Pick<ScorableStatLine, "assists" | "keyPasses" | "bigChancesCreated">,
): { keyPasses: number; bigChancesCreated: number } {
  const bigChancesCreated = Math.max(0, stat.bigChancesCreated - stat.assists);
  const keyPasses = Math.max(0, stat.keyPasses - bigChancesCreated);
  return { keyPasses, bigChancesCreated };
}

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
    shotsOnTarget: 0,
    shotsOffTarget: 0,
    tacklesSuccessful: 0,
    crosses: 0,
    passesCompleted: 0,
    keyPasses: 0,
    bigChancesCreated: 0,
    goalsConcededByKeeper: 0,
    gameWon: 0,
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

  // Detailed on-ball actions (any position). Fractional values; these are 0
  // until a provider supplies the counts or they are entered manually.
  breakdown.shotsOnTarget = round2(stat.shotsOnTarget * ruleset.shotOnTarget);
  breakdown.shotsOffTarget = round2(stat.shotsOffTarget * ruleset.shotOffTarget);
  breakdown.tacklesSuccessful = round2(stat.tacklesSuccessful * ruleset.tackleSuccessful);
  breakdown.crosses = round2(stat.crosses * ruleset.cross);
  breakdown.passesCompleted = round2(stat.passesCompleted * ruleset.passCompleted);

  // Playmaking rewards (any position), de-duplicated against assists and each
  // other so a single action is paid once (see effectivePlaymakingCounts).
  // `?? 0` guards rulesets persisted before these rules existed (e.g. a league
  // still on an older ruleset version): the field is absent at runtime even
  // though the type says number, and `count * undefined` would be NaN.
  const play = effectivePlaymakingCounts(stat);
  breakdown.keyPasses = round2(play.keyPasses * (ruleset.keyPass ?? 0));
  breakdown.bigChancesCreated = round2(
    play.bigChancesCreated * (ruleset.bigChanceCreated ?? 0),
  );

  // Goalkeeper-only rules.
  if (position === "GK") {
    breakdown.goalsConcededByKeeper = stat.goalsConceded * ruleset.goalConcededByKeeper;
    // Game won = scored strictly more than conceded in regulation + ET. A
    // shootout-only win is a draw here and earns nothing automatically.
    if (stat.teamScoredInRegulationAndEt > stat.teamConcededInRegulationAndEt) {
      breakdown.gameWon = ruleset.gameWonKeeper;
    }
  }

  const points = round2(
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
      breakdown.redCards +
      breakdown.shotsOnTarget +
      breakdown.shotsOffTarget +
      breakdown.tacklesSuccessful +
      breakdown.crosses +
      breakdown.passesCompleted +
      breakdown.keyPasses +
      breakdown.bigChancesCreated +
      breakdown.goalsConcededByKeeper +
      breakdown.gameWon,
  );

  return { points, breakdown };
}
