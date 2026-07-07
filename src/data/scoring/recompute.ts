/**
 * Score recomputation service.
 *
 * Rebuilds the score_entry table from stat_line + a ScoringRuleset. Two
 * entry points:
 *
 *   recomputeAll(db, ruleset)
 *     Scans every stat_line and upserts a score_entry row for each
 *     (player, fixture, ruleset.version) triple. Use after a ruleset
 *     change, or as a sanity-check rebuild.
 *
 *   recomputeForFixture(db, ruleset, sourceFixtureId)
 *     Same, but scoped to a single fixture. Use after ingest:fixture-stats
 *     so points become visible without rebuilding the whole tournament.
 *
 * Both functions are idempotent: running them with the same inputs leaves
 * the table identical. We detect "no-op" rows by comparing the existing
 * `points` and `breakdown` columns and skipping the write when nothing
 * changed - the recomputed result is byte-identical because scoring is a
 * pure function of its inputs.
 *
 * NOTE: score_entry rows for OTHER rulesets are left untouched. Recompute
 * is per-ruleset, so what-if rulesets can coexist with the canonical one.
 */

import { and, eq, inArray } from "drizzle-orm";

import type { Db } from "../db/client.js";
import {
  fixture,
  league,
  player,
  scoreEntry,
  statLine,
  type ScoreEntryRow,
} from "../db/schema.js";
import { emptySummary, type IngestSummary } from "../ingest/summary.js";
import type { ScoreBreakdown } from "./score.js";
import { scoreStatLine } from "./score.js";
import { DEFAULT_RULESET, type ScoringRuleset } from "./ruleset.js";

export type RecomputeSummary = IngestSummary;

/**
 * Recompute every stat_line under `ruleset`.
 *
 * Implementation note: we batch by reading all stat_line + player rows
 * once (the tournament has at most ~1,100 players × 104 fixtures × ~22 on
 * the squad per match ~= a few thousand rows). For tournaments larger than
 * the World Cup, this would need to chunk by fixture.
 */
export async function recomputeAll(
  db: Db,
  ruleset: ScoringRuleset,
): Promise<RecomputeSummary> {
  const rows = await db
    .select({
      playerId: statLine.playerId,
      fixtureId: statLine.fixtureId,
      minutesPlayed: statLine.minutesPlayed,
      goals: statLine.goals,
      assists: statLine.assists,
      saves: statLine.saves,
      yellowCards: statLine.yellowCards,
      redCards: statLine.redCards,
      penaltiesScored: statLine.penaltiesScored,
      penaltiesMissed: statLine.penaltiesMissed,
      penaltiesSaved: statLine.penaltiesSaved,
      ownGoals: statLine.ownGoals,
      teamConcededInRegulationAndEt: statLine.teamConcededInRegulationAndEt,
      shotsOnTarget: statLine.shotsOnTarget,
      shotsOffTarget: statLine.shotsOffTarget,
      tacklesSuccessful: statLine.tacklesSuccessful,
      crosses: statLine.crosses,
      passesCompleted: statLine.passesCompleted,
      keyPasses: statLine.keyPasses,
      bigChancesCreated: statLine.bigChancesCreated,
      goalsConceded: statLine.goalsConceded,
      teamScoredInRegulationAndEt: statLine.teamScoredInRegulationAndEt,
      position: player.position,
      stage: fixture.stage,
      kickoffUtc: fixture.kickoffUtc,
    })
    .from(statLine)
    .innerJoin(player, eq(player.id, statLine.playerId))
    .innerJoin(fixture, eq(fixture.id, statLine.fixtureId));

  // Existing rows for this ruleset, keyed (playerId, fixtureId).
  const existing = await db
    .select()
    .from(scoreEntry)
    .where(eq(scoreEntry.rulesetVersion, ruleset.version));
  const existingByKey = new Map<string, ScoreEntryRow>(
    existing.map((r) => [`${r.playerId}:${r.fixtureId}`, r]),
  );

  const streakSet = streakSetForRuleset(ruleset, rows);

  const summary = emptySummary();
  for (const r of rows) {
    const key = `${r.playerId}:${r.fixtureId}`;
    const result = scoreStatLine(r, r.position, ruleset, {
      stage: r.stage,
      streakQualified: streakSet.has(key),
    });
    const prev = existingByKey.get(key);

    // Unchanged row: skip the write entirely to avoid churn.
    if (
      prev &&
      prev.points === result.points &&
      breakdownEquals(prev.breakdown as ScoreBreakdown, result.breakdown)
    ) {
      summary.skipped += 1;
      continue;
    }

    // Upsert on the score_entry primary key. ON CONFLICT keeps recompute
    // idempotent and immune to a pre-existing row the `existing` snapshot did
    // not include (e.g. a leftover row from an interrupted run, or a stale
    // read on a pooled connection) — a bare INSERT would hit those as a
    // duplicate-key violation and abort the whole recompute.
    await db
      .insert(scoreEntry)
      .values({
        playerId: r.playerId,
        fixtureId: r.fixtureId,
        rulesetVersion: ruleset.version,
        points: result.points,
        breakdown: result.breakdown,
      })
      .onConflictDoUpdate({
        target: [
          scoreEntry.playerId,
          scoreEntry.fixtureId,
          scoreEntry.rulesetVersion,
        ],
        set: {
          points: result.points,
          breakdown: result.breakdown,
          computedAt: new Date(),
        },
      });

    if (prev) summary.updated += 1;
    else summary.inserted += 1;
  }
  return summary;
}

/**
 * Recompute scores for EVERY scoring ruleset currently in use.
 *
 * `score_entry` rows are keyed by `ruleset_version`, and standings read each
 * league's own `scoring_ruleset`. So a single `recomputeAll(db, DEFAULT_RULESET)`
 * only produces rows for the default version — any league with a customised
 * ruleset would then have no score rows and show zeros. This gathers the
 * distinct rulesets across all leagues (always including the default as a
 * baseline) and recomputes each, so every league's standings stay populated.
 *
 * Call this from the ingest pipeline / cron instead of `recomputeAll`.
 */
export async function recomputeAllRulesets(
  db: Db,
): Promise<{ rulesets: number; total: RecomputeSummary }> {
  const rows = await db.select({ scoringRuleset: league.scoringRuleset }).from(league);
  const byVersion = new Map<string, ScoringRuleset>();
  byVersion.set(DEFAULT_RULESET.version, DEFAULT_RULESET);
  for (const r of rows) {
    const rs = r.scoringRuleset as ScoringRuleset | null;
    if (rs?.version) byVersion.set(rs.version, rs);
  }

  const total = emptySummary();
  for (const rs of byVersion.values()) {
    const s = await recomputeAll(db, rs);
    total.inserted += s.inserted;
    total.updated += s.updated;
    total.skipped += s.skipped;
  }
  return { rulesets: byVersion.size, total };
}

/**
 * Recompute scores for a single fixture identified by its provider id.
 */
export async function recomputeForFixture(
  db: Db,
  ruleset: ScoringRuleset,
  sourceFixtureId: string,
): Promise<RecomputeSummary> {
  const [fxRow] = await db
    .select({ id: fixture.id })
    .from(fixture)
    .where(eq(fixture.sourceFixtureId, sourceFixtureId));
  if (!fxRow) {
    throw new Error(
      `fixture ${sourceFixtureId} not present in DB. Run ingest:schedule first.`,
    );
  }

  const rows = await db
    .select({
      playerId: statLine.playerId,
      fixtureId: statLine.fixtureId,
      minutesPlayed: statLine.minutesPlayed,
      goals: statLine.goals,
      assists: statLine.assists,
      saves: statLine.saves,
      yellowCards: statLine.yellowCards,
      redCards: statLine.redCards,
      penaltiesScored: statLine.penaltiesScored,
      penaltiesMissed: statLine.penaltiesMissed,
      penaltiesSaved: statLine.penaltiesSaved,
      ownGoals: statLine.ownGoals,
      teamConcededInRegulationAndEt: statLine.teamConcededInRegulationAndEt,
      shotsOnTarget: statLine.shotsOnTarget,
      shotsOffTarget: statLine.shotsOffTarget,
      tacklesSuccessful: statLine.tacklesSuccessful,
      crosses: statLine.crosses,
      passesCompleted: statLine.passesCompleted,
      keyPasses: statLine.keyPasses,
      bigChancesCreated: statLine.bigChancesCreated,
      goalsConceded: statLine.goalsConceded,
      teamScoredInRegulationAndEt: statLine.teamScoredInRegulationAndEt,
      position: player.position,
      stage: fixture.stage,
      kickoffUtc: fixture.kickoffUtc,
    })
    .from(statLine)
    .innerJoin(player, eq(player.id, statLine.playerId))
    .innerJoin(fixture, eq(fixture.id, statLine.fixtureId))
    .where(eq(statLine.fixtureId, fxRow.id));

  const existing = await db
    .select()
    .from(scoreEntry)
    .where(
      and(
        eq(scoreEntry.fixtureId, fxRow.id),
        eq(scoreEntry.rulesetVersion, ruleset.version),
      ),
    );
  const existingByKey = new Map<string, ScoreEntryRow>(
    existing.map((r) => [`${r.playerId}:${r.fixtureId}`, r]),
  );

  // Streaks need the affected players' OTHER fixtures too.
  let streakSet = new Set<string>();
  if (ruleset.bonuses !== undefined && rows.length > 0) {
    const history = await db
      .select({
        playerId: statLine.playerId,
        fixtureId: statLine.fixtureId,
        goals: statLine.goals,
        minutesPlayed: statLine.minutesPlayed,
        kickoffUtc: fixture.kickoffUtc,
      })
      .from(statLine)
      .innerJoin(fixture, eq(fixture.id, statLine.fixtureId))
      .where(
        inArray(
          statLine.playerId,
          rows.map((r) => r.playerId),
        ),
      );
    streakSet = computeStreakSet(history, ruleset.bonuses.scoringStreak.length);
  }

  const summary = emptySummary();
  for (const r of rows) {
    const key = `${r.playerId}:${r.fixtureId}`;
    const result = scoreStatLine(r, r.position, ruleset, {
      stage: r.stage,
      streakQualified: streakSet.has(key),
    });
    const prev = existingByKey.get(key);

    // Unchanged row: skip the write entirely to avoid churn.
    if (
      prev &&
      prev.points === result.points &&
      breakdownEquals(prev.breakdown as ScoreBreakdown, result.breakdown)
    ) {
      summary.skipped += 1;
      continue;
    }

    // Upsert on the score_entry primary key. ON CONFLICT keeps recompute
    // idempotent and immune to a pre-existing row the `existing` snapshot did
    // not include (e.g. a leftover row from an interrupted run, or a stale
    // read on a pooled connection) — a bare INSERT would hit those as a
    // duplicate-key violation and abort the whole recompute.
    await db
      .insert(scoreEntry)
      .values({
        playerId: r.playerId,
        fixtureId: r.fixtureId,
        rulesetVersion: ruleset.version,
        points: result.points,
        breakdown: result.breakdown,
      })
      .onConflictDoUpdate({
        target: [
          scoreEntry.playerId,
          scoreEntry.fixtureId,
          scoreEntry.rulesetVersion,
        ],
        set: {
          points: result.points,
          breakdown: result.breakdown,
          computedAt: new Date(),
        },
      });

    if (prev) summary.updated += 1;
    else summary.inserted += 1;
  }
  return summary;
}

/** Cheap structural equality for ScoreBreakdown JSON. */
/** One row of scoring-streak input (pure core below). */
export interface StreakInputRow {
  playerId: number;
  fixtureId: number;
  goals: number;
  minutesPlayed: number;
  kickoffUtc: Date;
}

/**
 * Phase-07 scoring streaks - pure. Per player, walk PLAYED matches in
 * kickoff order; a goal extends the run, a scoreless played match resets
 * it, bench matches are skipped. Every match where the run length reaches
 * `length` earns the bonus (i.e. the Nth match onward while it survives).
 * Returns the qualifying "playerId:fixtureId" keys.
 */
export function computeStreakSet(
  rows: readonly StreakInputRow[],
  length: number,
): Set<string> {
  const byPlayer = new Map<number, StreakInputRow[]>();
  for (const r of rows) {
    if (r.minutesPlayed <= 0) continue;
    const list = byPlayer.get(r.playerId) ?? [];
    list.push(r);
    byPlayer.set(r.playerId, list);
  }
  const out = new Set<string>();
  for (const list of byPlayer.values()) {
    list.sort(
      (a, b) => a.kickoffUtc.getTime() - b.kickoffUtc.getTime() || a.fixtureId - b.fixtureId,
    );
    let run = 0;
    for (const r of list) {
      run = r.goals >= 1 ? run + 1 : 0;
      if (run >= length) out.add(`${r.playerId}:${r.fixtureId}`);
    }
  }
  return out;
}

/** Streak keys for a full-rows recompute; empty unless bonuses are on. */
function streakSetForRuleset(
  ruleset: ScoringRuleset,
  rows: readonly StreakInputRow[],
): Set<string> {
  if (ruleset.bonuses === undefined) return new Set();
  return computeStreakSet(rows, ruleset.bonuses.scoringStreak.length);
}

function breakdownEquals(a: ScoreBreakdown, b: ScoreBreakdown): boolean {
  return (
    a.bonus === b.bonus &&
    a.stageMultiplier === b.stageMultiplier &&
    a.appearance === b.appearance &&
    a.played60Plus === b.played60Plus &&
    a.goals === b.goals &&
    a.assists === b.assists &&
    a.saves === b.saves &&
    a.cleanSheet === b.cleanSheet &&
    a.penaltiesSaved === b.penaltiesSaved &&
    a.penaltiesMissed === b.penaltiesMissed &&
    a.ownGoals === b.ownGoals &&
    a.yellowCards === b.yellowCards &&
    a.redCards === b.redCards &&
    a.shotsOnTarget === b.shotsOnTarget &&
    a.shotsOffTarget === b.shotsOffTarget &&
    a.tacklesSuccessful === b.tacklesSuccessful &&
    a.crosses === b.crosses &&
    a.passesCompleted === b.passesCompleted &&
    a.keyPasses === b.keyPasses &&
    a.bigChancesCreated === b.bigChancesCreated &&
    a.goalsConcededByKeeper === b.goalsConcededByKeeper &&
    a.gameWon === b.gameWon
  );
}
