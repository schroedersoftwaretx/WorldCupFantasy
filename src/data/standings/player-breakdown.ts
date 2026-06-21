/**
 * Per-player score breakdown (read model).
 *
 * Answers "why does this player have N points?" by pairing each stored
 * `score_entry.breakdown` (the per-rule contributions the scoring engine
 * already computed) with the raw `stat_line` counts that produced them.
 * Pure read - no writes, no recompute. Because the breakdown is read
 * straight from `score_entry`, what the UI shows always sums to exactly the
 * points used in standings (same ruleset version).
 *
 * One player can have several scored fixtures (one per matchday/knockout
 * tie). Each fixture is returned with its own list of non-zero rule rows so
 * the UI can show, e.g., "Goals 1 x +4 = +4" beneath the fixture total.
 */

import { asc, eq, inArray } from "drizzle-orm";

import type { Db } from "../db/client.js";
import {
  fixture,
  league,
  nationalTeam,
  player,
  scoreEntry,
  statLine,
  type Position,
  type Stage,
} from "../db/schema.js";
import type { ScoreBreakdown } from "../scoring/score.js";
import { effectivePlaymakingCounts } from "../scoring/score.js";
import type { ScoringRuleset } from "../scoring/ruleset.js";
import { ownershipForPlayer } from "../stats/ownership.js";
import { adpByPlayerId } from "../stats/adp.js";

/** One scoring rule's contribution within a single fixture. */
export interface PlayerBreakdownRule {
  /** Stable key matching a ScoreBreakdown field, e.g. "goals". */
  key: keyof ScoreBreakdown;
  /** Human label, e.g. "Goals". */
  label: string;
  /**
   * The underlying stat count (e.g. 2 goals, 3 saves). `null` for binary or
   * derived rules that have no count (appearance, 60+ minutes, clean sheet,
   * game won) - those show only their points.
   */
  count: number | null;
  /** Points added by this rule in this fixture (the breakdown value). */
  points: number;
}

/** A single scored fixture for the player, with its per-rule rows. */
export interface PlayerBreakdownFixture {
  fixtureId: number;
  stage: Stage;
  /** Opponent label from the player's perspective, e.g. "vs Mexico". */
  opponent: string;
  kickoffUtc: string;
  /** Sum of the rule rows == score_entry.points for this fixture. */
  total: number;
  /** Only the rules that contributed (non-zero), highest magnitude first. */
  rules: PlayerBreakdownRule[];
}

/** Full breakdown payload for one player across all their scored fixtures. */
export interface PlayerBreakdown {
  playerId: number;
  fullName: string;
  position: Position;
  rulesetVersion: string;
  /** Cross-league ownership context (Phase 2). Aggregate-only. */
  ownership: {
    ownedCount: number;
    ownershipPct: number;
    totalFantasyTeams: number;
  };
  /** Cross-league average draft position, or null if never drafted (Phase 2). */
  adp: number | null;
  fixtures: PlayerBreakdownFixture[];
}

/**
 * Display order + labels for the breakdown rows. Order is roughly
 * "appearance -> attacking -> defensive -> discipline -> keeper".
 */
const RULE_LABELS: { key: keyof ScoreBreakdown; label: string }[] = [
  { key: "appearance", label: "Appearance" },
  { key: "played60Plus", label: "60+ minutes" },
  { key: "goals", label: "Goals" },
  { key: "assists", label: "Assists" },
  { key: "shotsOnTarget", label: "Shots on target" },
  { key: "shotsOffTarget", label: "Shots off target" },
  { key: "bigChancesCreated", label: "Big chances created" },
  { key: "keyPasses", label: "Key passes" },
  { key: "crosses", label: "Crosses" },
  { key: "passesCompleted", label: "Passes completed" },
  { key: "tacklesSuccessful", label: "Tackles won" },
  { key: "cleanSheet", label: "Clean sheet" },
  { key: "saves", label: "Saves" },
  { key: "penaltiesSaved", label: "Penalties saved" },
  { key: "gameWon", label: "Game won (GK)" },
  { key: "goalsConcededByKeeper", label: "Goals conceded (GK)" },
  { key: "penaltiesMissed", label: "Penalties missed" },
  { key: "ownGoals", label: "Own goals" },
  { key: "yellowCards", label: "Yellow cards" },
  { key: "redCards", label: "Red cards" },
];

/**
 * Map each breakdown rule to the raw stat count it derives from, so the UI
 * can render "Goals 2 x +4". Rules with no meaningful count return null.
 */
function ruleCount(
  key: keyof ScoreBreakdown,
  stat: typeof statLine.$inferSelect,
): number | null {
  switch (key) {
    case "goals":
      return stat.goals;
    case "assists":
      return stat.assists;
    case "saves":
      return stat.saves;
    case "shotsOnTarget":
      return stat.shotsOnTarget;
    case "shotsOffTarget":
      return stat.shotsOffTarget;
    case "tacklesSuccessful":
      return stat.tacklesSuccessful;
    case "crosses":
      return stat.crosses;
    case "passesCompleted":
      return stat.passesCompleted;
    // Show the de-duplicated counts that actually earned points, so the
    // "count × rate = points" the UI renders stays internally consistent.
    case "keyPasses":
      return effectivePlaymakingCounts(stat).keyPasses;
    case "bigChancesCreated":
      return effectivePlaymakingCounts(stat).bigChancesCreated;
    case "penaltiesSaved":
      return stat.penaltiesSaved;
    case "penaltiesMissed":
      return stat.penaltiesMissed;
    case "ownGoals":
      return stat.ownGoals;
    case "yellowCards":
      return stat.yellowCards;
    case "redCards":
      return stat.redCards;
    case "goalsConcededByKeeper":
      return stat.goalsConceded;
    // Binary / derived rules: no count.
    case "appearance":
    case "played60Plus":
    case "cleanSheet":
    case "gameWon":
      return null;
    default:
      return null;
  }
}

/**
 * Pure: turn a stored breakdown + (optional) stat line into the non-zero
 * per-rule rows, largest magnitude first. Exported so it can be unit-tested
 * against the scoring engine without a database.
 */
export function buildRuleRows(
  breakdown: ScoreBreakdown,
  stat: typeof statLine.$inferSelect | null,
): PlayerBreakdownRule[] {
  const rows: PlayerBreakdownRule[] = [];
  for (const { key, label } of RULE_LABELS) {
    const points = breakdown[key] ?? 0;
    if (points === 0) continue;
    rows.push({
      key,
      label,
      count: stat ? ruleCount(key, stat) : null,
      points,
    });
  }
  rows.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  return rows;
}

/**
 * Build the breakdown for one player in one league. Returns `null` if the
 * player does not exist; an empty `fixtures` list means the player has no
 * scored fixtures yet (e.g. before the tournament starts).
 */
export async function getPlayerBreakdown(
  db: Db,
  leagueId: number,
  playerId: number,
): Promise<PlayerBreakdown | null> {
  const [lg] = await db.select().from(league).where(eq(league.id, leagueId));
  if (!lg) throw new Error(`league ${leagueId} does not exist`);
  const rulesetVersion = (lg.scoringRuleset as ScoringRuleset).version;
  return getPlayerBreakdownForRuleset(db, rulesetVersion, playerId);
}

/**
 * Build a player's breakdown against an EXPLICIT ruleset version, independent
 * of any league. The public Stats Hub uses this with HUB_RULESET_VERSION so a
 * player's per-fixture scoring can be inspected without joining a league. Same
 * payload shape as {@link getPlayerBreakdown}.
 */
export async function getPlayerBreakdownForRuleset(
  db: Db,
  rulesetVersion: string,
  playerId: number,
): Promise<PlayerBreakdown | null> {
  const [p] = await db.select().from(player).where(eq(player.id, playerId));
  if (!p) return null;

  // Cross-league context (Phase 2): aggregate ownership % and ADP for the
  // player. Independent of the league's ruleset; safe to expose (no per-team
  // detail). adpByPlayerId returns every drafted player keyed by id.
  const ownership = await ownershipForPlayer(db, playerId);
  const adpMap = await adpByPlayerId(db, {});
  const adp = adpMap.byPlayerId.get(playerId)?.adp ?? null;

  // This player's score_entry rows for the active ruleset only.
  const scores = await db
    .select()
    .from(scoreEntry)
    .where(eq(scoreEntry.playerId, playerId));
  const myScores = scores.filter((s) => s.rulesetVersion === rulesetVersion);

  if (myScores.length === 0) {
    return {
      playerId: p.id,
      fullName: p.fullName,
      position: p.position,
      rulesetVersion,
      ownership,
      adp,
      fixtures: [],
    };
  }

  // Stat lines + fixtures + team names for the scored fixtures.
  const fixtureIds = Array.from(new Set(myScores.map((s) => s.fixtureId)));
  const stats = await db
    .select()
    .from(statLine)
    .where(eq(statLine.playerId, playerId));
  const statByFixture = new Map(stats.map((s) => [s.fixtureId, s]));

  const fixtures = await db
    .select()
    .from(fixture)
    .where(inArray(fixture.id, fixtureIds))
    .orderBy(asc(fixture.kickoffUtc));
  const fixtureById = new Map(fixtures.map((f) => [f.id, f]));

  const teams = await db.select().from(nationalTeam);
  const teamName = new Map(teams.map((t) => [t.id, t.name]));

  const result: PlayerBreakdownFixture[] = [];
  for (const fx of fixtures) {
    const score = myScores.find((s) => s.fixtureId === fx.id);
    if (!score) continue;
    const breakdown = score.breakdown as ScoreBreakdown;
    const stat = statByFixture.get(fx.id);

    const rules = buildRuleRows(breakdown, stat ?? null);

    // Opponent from the player's perspective.
    const isHome = fx.homeTeamId === p.nationalTeamId;
    const oppId = isHome ? fx.awayTeamId : fx.homeTeamId;
    const opponent = `vs ${teamName.get(oppId) ?? `team #${oppId}`}`;

    result.push({
      fixtureId: fx.id,
      stage: fx.stage,
      opponent,
      kickoffUtc: fx.kickoffUtc.toISOString(),
      total: score.points,
      rules,
    });
  }

  // Keep map-derived ordering deterministic by kickoff (already ordered).
  void fixtureById;

  return {
    playerId: p.id,
    fullName: p.fullName,
    position: p.position,
    rulesetVersion,
    ownership,
    adp,
    fixtures: result,
  };
}
