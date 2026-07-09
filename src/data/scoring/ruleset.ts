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

import { stageEnum, type Position, type Stage } from "../db/schema.js";

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
  /** Each key pass — a pass leading to a shot (any position). Playmaker reward. */
  readonly keyPass: number;
  /** Each big chance created (any position). Playmaker reward. */
  readonly bigChanceCreated: number;
  /**
   * Per goal conceded, charged to the GOALKEEPER only. Negative. Applied to
   * stat.goalsConceded (the keeper's own conceded count, which for a keeper
   * who played the whole match equals teamConcededInRegulationAndEt).
   */
  readonly goalConcededByKeeper: number;
  /**
   * Flat bonus when the player's team WON, awarded to the GOALKEEPER only.
   * A win is either scoring more than conceded in regulation + extra time, or
   * — when level after ET — winning the penalty shootout. Both are derived
   * from the stat line (teamScored/Conceded and teamShootoutScored/Conceded).
   */
  readonly gameWonKeeper: number;

  /**
   * Phase-07 7.2 opt-in bonus block. ABSENT by default - and it must stay
   * absent in the default ruleset, because the version is a content hash:
   * an absent optional key serializes to nothing, keeping every existing
   * league's version (and its score_entry rows) byte-identical. A league
   * that adopts bonuses gets a NEW version and a league-scoped recompute,
   * exactly like any other ruleset edit.
   */
  readonly bonuses?: RulesetBonuses;
}

/** Opt-in milestone / stage / streak bonuses (phase-07 7.2). */
export interface RulesetBonuses {
  /** Bonus for scoring exactly 2 goals in one match. */
  readonly brace: number;
  /** Bonus for 3+ goals in one match (replaces brace; not stacked). */
  readonly hatTrick: number;
  /**
   * Whole-score multiplier per stage (e.g. { SF: 1.5, FINAL: 2 }). A stage
   * missing from the map multiplies by 1. Applied AFTER all flat bonuses.
   */
  readonly stageMultipliers: Readonly<Partial<Record<Stage, number>>>;
  /**
   * Bonus for each match that extends a scoring streak to `length` or more
   * consecutive PLAYED matches with a goal (bench matches are skipped, a
   * played match without a goal resets the run).
   */
  readonly scoringStreak: Readonly<{ length: number; bonus: number }>;
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
  keyPass: 0.5,
  bigChanceCreated: 2,
  goalConcededByKeeper: -1,
  gameWonKeeper: 5,
});

/**
 * Thrown by {@link sanitizeRulesetInput} when an untrusted payload cannot be
 * coerced into a valid ruleset. The API layer maps this to a 400.
 */
export class RulesetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RulesetValidationError";
  }
}

/** Coerce a point value: finite, within +/-100, snapped to 2dp (engine uses round2). */
function pointValue(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new RulesetValidationError(`${label} must be a finite number`);
  }
  if (n < -100 || n > 100) {
    throw new RulesetValidationError(`${label} must be between -100 and 100`);
  }
  return Math.round(n * 100) / 100;
}

/** Coerce an integer in [min, max]. */
function intValue(value: unknown, label: string, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n)) {
    throw new RulesetValidationError(`${label} must be a whole number`);
  }
  if (n < min || n > max) {
    throw new RulesetValidationError(`${label} must be between ${min} and ${max}`);
  }
  return n;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RulesetValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Validate + coerce an untrusted payload (e.g. an API request body) into the
 * value half of a ScoringRuleset. Every numeric field is required and range-
 * checked; unknown extra keys are ignored. Pass the result to {@link buildRuleset}
 * to compute the content-hash version. Throws {@link RulesetValidationError} on
 * any malformed field so the caller can return a clean 400.
 *
 * cleanSheetByPosition is fixed to GK + DEF (the only positions that earn a
 * clean sheet); MID/FWD values in the payload are ignored.
 */
export function sanitizeRulesetInput(
  input: unknown,
): Omit<ScoringRuleset, "version"> {
  const o = asObject(input, "ruleset");
  const goals = asObject(o["goalByPosition"], "goalByPosition");
  const clean = asObject(o["cleanSheetByPosition"], "cleanSheetByPosition");

  return {
    appearance: pointValue(o["appearance"], "appearance"),
    played60Plus: pointValue(o["played60Plus"], "played60Plus"),
    goalByPosition: {
      GK: pointValue(goals["GK"], "goalByPosition.GK"),
      DEF: pointValue(goals["DEF"], "goalByPosition.DEF"),
      MID: pointValue(goals["MID"], "goalByPosition.MID"),
      FWD: pointValue(goals["FWD"], "goalByPosition.FWD"),
    },
    assist: pointValue(o["assist"], "assist"),
    save: pointValue(o["save"], "save"),
    cleanSheetByPosition: {
      GK: pointValue(clean["GK"], "cleanSheetByPosition.GK"),
      DEF: pointValue(clean["DEF"], "cleanSheetByPosition.DEF"),
    },
    cleanSheetMinMinutes: intValue(o["cleanSheetMinMinutes"], "cleanSheetMinMinutes", 0, 120),
    penaltySaved: pointValue(o["penaltySaved"], "penaltySaved"),
    penaltyMissed: pointValue(o["penaltyMissed"], "penaltyMissed"),
    ownGoal: pointValue(o["ownGoal"], "ownGoal"),
    yellowCard: pointValue(o["yellowCard"], "yellowCard"),
    redCard: pointValue(o["redCard"], "redCard"),
    shotOnTarget: pointValue(o["shotOnTarget"], "shotOnTarget"),
    shotOffTarget: pointValue(o["shotOffTarget"], "shotOffTarget"),
    tackleSuccessful: pointValue(o["tackleSuccessful"], "tackleSuccessful"),
    cross: pointValue(o["cross"], "cross"),
    passCompleted: pointValue(o["passCompleted"], "passCompleted"),
    keyPass: pointValue(o["keyPass"], "keyPass"),
    bigChanceCreated: pointValue(o["bigChanceCreated"], "bigChanceCreated"),
    goalConcededByKeeper: pointValue(o["goalConcededByKeeper"], "goalConcededByKeeper"),
    gameWonKeeper: pointValue(o["gameWonKeeper"], "gameWonKeeper"),
    ...(o["bonuses"] !== undefined && o["bonuses"] !== null
      ? { bonuses: sanitizeBonuses(o["bonuses"]) }
      : {}),
  };
}

/** Coerce a multiplier: finite, 0..10, 2dp. */
function multiplierValue(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new RulesetValidationError(`${label} must be a finite number`);
  }
  if (n < 0 || n > 10) {
    throw new RulesetValidationError(`${label} must be between 0 and 10`);
  }
  return Math.round(n * 100) / 100;
}

/** Validate the optional phase-07 bonuses block. */
function sanitizeBonuses(input: unknown): RulesetBonuses {
  const o = asObject(input, "bonuses");
  const streak = asObject(o["scoringStreak"], "bonuses.scoringStreak");
  const multsIn = asObject(o["stageMultipliers"] ?? {}, "bonuses.stageMultipliers");
  const stageMultipliers: Partial<Record<Stage, number>> = {};
  for (const key of Object.keys(multsIn)) {
    if (!(stageEnum.enumValues as readonly string[]).includes(key)) {
      throw new RulesetValidationError(
        `bonuses.stageMultipliers.${key} is not a stage`,
      );
    }
    stageMultipliers[key as Stage] = multiplierValue(
      multsIn[key],
      `bonuses.stageMultipliers.${key}`,
    );
  }
  return {
    brace: pointValue(o["brace"], "bonuses.brace"),
    hatTrick: pointValue(o["hatTrick"], "bonuses.hatTrick"),
    stageMultipliers,
    scoringStreak: {
      length: intValue(streak["length"], "bonuses.scoringStreak.length", 2, 10),
      bonus: pointValue(streak["bonus"], "bonuses.scoringStreak.bonus"),
    },
  };
}
