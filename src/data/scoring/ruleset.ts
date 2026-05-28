/**
 * Scoring ruleset (Phase 2).
 *
 * A ScoringRuleset is a pure-data object: pass it into scoreStatLine() and
 * you get back a deterministic point total. It carries every constant that
 * appears in section 5.1 of the project plan, so changing a rule means
 * editing this file (or supplying a custom ruleset to the engine) - never
 * the scoring function itself.
 *
 * Why a "version" field? Phase 5 standings will read from the score_entry
 * table, which is keyed in part by ruleset_version. That lets multiple
 * rulesets coexist on disk for what-if analysis without one wiping the
 * other, and lets the recompute service detect when a ruleset has changed
 * and rebuild only the rows that need it.
 *
 * The version string is a content hash derived from the ruleset values
 * themselves. Two structurally identical rulesets produce the same
 * version; any change to a point value yields a new version. That gives
 * us cache invalidation for free.
 */

import { createHash } from "node:crypto";

import type { Position } from "../db/schema.js";

export interface ScoringRuleset {
  /**
   * Deterministic content-hash identifier for this ruleset, e.g.
   *   "wcf-v1-7a3e9c4b"
   * Same point values -> same id; any change -> new id.
   */
  readonly version: string;

  /** +1 for any minutes played (the player appeared). */
  readonly appearance: number;
  /** Additional +1 if the player was on the pitch for 60+ minutes. */
  readonly played60Plus: number;

  /** Goals score differently by the scorer's position. */
  readonly goalByPosition: Readonly<Record<Position, number>>;
  /** Assists score the same regardless of position. */
  readonly assist: number;
  /** Each save the GK makes (typical: only GKs accumulate these). */
  readonly save: number;

  /**
   * Clean sheet bonus by position. Only GK and DEF earn it; MID/FWD are
   * absent from the map. Awarded only when:
   *   - player played at least `cleanSheetMinMinutes`
   *   - team conceded 0 goals in regulation + extra time (penalty
   *     shootouts excluded - already enforced at the stat_line layer).
   */
  readonly cleanSheetByPosition: Readonly<Partial<Record<Position, number>>>;
  readonly cleanSheetMinMinutes: number;

  /** GK saves a penalty (open play or shootout? plan says yes either way). */
  readonly penaltySaved: number;
  /** Any player misses a penalty (open play). */
  readonly penaltyMissed: number;
  /** Own goal. Negative. */
  readonly ownGoal: number;
  /** Yellow card. Negative. */
  readonly yellowCard: number;
  /** Red card. Negative. Per-type (not escalating). */
  readonly redCard: number;
}

/**
 * Build a stable content-hash version id for a ruleset. The hash inputs are
 * sorted by key so JSON insertion order does not affect the result.
 */
function hashRuleset(values: Omit<ScoringRuleset, "version">): string {
  const canonical = JSON.stringify(values, Object.keys(values).sort());
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 8);
  return `wcf-v1-${digest}`;
}

/**
 * Build a ruleset from raw values, computing the version automatically.
 * Always go through this when constructing or overriding rulesets so the
 * version stays in sync with content.
 */
export function buildRuleset(values: Omit<ScoringRuleset, "version">): ScoringRuleset {
  return Object.freeze({ ...values, version: hashRuleset(values) });
}

/**
 * Canonical default ruleset matching section 5.1 of WORLDCUP_FANTASY_PLAN.md.
 * Any deviation from these values is a real product decision and should be
 * reviewed against the spec.
 */
export const DEFAULT_RULESET: ScoringRuleset = buildRuleset({
  appearance: 1,
  played60Plus: 1,
  goalByPosition: {
    GK: 10,
    DEF: 6,
    MID: 5,
    FWD: 4,
  },
  assist: 4,
  save: 1,
  cleanSheetByPosition: {
    GK: 5,
    DEF: 5,
  },
  cleanSheetMinMinutes: 60,
  penaltySaved: 5,
  penaltyMissed: -2,
  ownGoal: -2,
  yellowCard: -1,
  redCard: -3,
});
