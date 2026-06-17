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

  // --- Detailed-action rules (v2) -------------------------------------------
  // These reward on-ball actions that only the richer providers (Sportmonks,
  // Opta/FBref) expose per player. When a provider can't supply a field it
  // arrives as 0, so the rule simply contributes nothing until the data is
  // present (or is hand-entered via the manual stat editor). Several values
  // are fractional, which is why score_entry.points is a real column.

  /** Each shot on target (any position). */
  readonly shotOnTarget: number;
  /** Each shot off target (any position). */
  readonly shotOffTarget: number;
  /** Each successful tackle (any position). */
  readonly tackleSuccessful: number;
  /** Each cross (any position). */
  readonly cross: number;
  /** Each completed pass (any position). Small per-event value. */
  readonly passCompleted: number;
  /**
   * Per goal conceded, charged to the GOALKEEPER only. Negative. Applied to
   * stat.goalsConceded (the keeper's own conceded count, which for a keeper
   * who played the whole match equals teamConcededInRegulationAndEt).
   */
  readonly goalConcededByKeeper: number;
  /**
   * Flat bonus when the player's team WON in regulation + extra time,
   * awarded to the GOALKEEPER only. Shootout-only wins are not counted here
   * (edit the stat line manually for those rare cases).
   */
  readonly gameWonKeeper: number;
}

/**
 * Recursively sort object keys so JSON insertion order does not affect the
 * result. NOTE: we must NOT use JSON.stringify's array-replacer form for this
 * (`JSON.stringify(v, Object.keys(v).sort())`) - that array is a key
 * allowlist applied at every nesting level, so nested maps like
 * goalByPosition / cleanSheetByPosition (whose keys GK/DEF/MID/FWD are not in
 * the top-level key list) serialize as empty objects and drop out of the hash.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalize(obj[key]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * Build a stable content-hash version id for a ruleset. Every value,
 * including nested per-position maps, contributes to the hash.
 */
function hashRuleset(values: Omit<ScoringRuleset, "version">): string {
  const canonical = JSON.stringify(canonicalize(values));
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 8);
  return `wcf-v1-${digest}`;
}

/**
 * Build a ruleset from raw values, computing the version automatically.
 * Always go through this when constructing or overriding rulesets so the
 * version stays in sync with content. Any incoming `version` is ignored and
 * recomputed, so spreading an existing ruleset (`{ ...DEFAULT_RULESET, ... }`)
 * does not smuggle a stale id into the hash input.
 */
export function buildRuleset(
  values: Omit<ScoringRuleset, "version"> & { version?: string },
): ScoringRuleset {
  const { version: _ignored, ...rest } = values as ScoringRuleset;
  return Object.freeze({ ...rest, version: hashRuleset(rest) });
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
    GK: 12,
    DEF: 7,
    MID: 6,
    FWD: 5,
  },
  assist: 4,
  save: 1,
  cleanSheetByPosition: {
    GK: 5,
    DEF: 5,
  },
  cleanSheetMinMinutes: 60,
  penaltySaved: 2,
  penaltyMissed: -2,
  ownGoal: -2,
  yellowCard: -1,
  redCard: -5,
  shotOnTarget: 1,
  shotOffTarget: 0.5,
  tackleSuccessful: 0.5,
  cross: 0.5,
  passCompleted: 0.05,
  goalConcededByKeeper: -1,
  gameWonKeeper: 5,
});
