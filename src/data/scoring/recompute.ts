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

import { and, eq } from "drizzle-orm";

import type { Db } from "../db/client.js";
import {
  fixture,
  player,
  scoreEntry,
  statLine,
  type ScoreEntryRow,
} from "../db/schema.js";
import { emptySummary, type IngestSummary } from "../ingest/summary.js";
import type { ScoreBreakdown } from "./score.js";
import { scoreStatLine } from "./score.js";
import type { ScoringRuleset } from "./ruleset.js";

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
      goalsConceded: statLine.goalsConceded,
      teamScoredInRegulationAndEt: statLine.teamScoredInRegulationAndEt,
      position: player.position,
    })
    .from(statLine)
    .innerJoin(player, eq(player.id, statLine.playerId));

  // Existing rows for this ruleset, keyed (playerId, fixtureId).
  const existing = await db
    .select()
    .from(scoreEntry)
    .where(eq(scoreEntry.rulesetVersion, ruleset.version));
  const existingByKey = new Map<string, ScoreEntryRow>(
    existing.map((r) => [`${r.playerId}:${r.fixtureId}`, r]),
  );

  const summary = emptySummary();
  for (const r of rows) {
    const result = scoreStatLine(r, r.position, ruleset);
    const key = `${r.playerId}:${r.fixtureId}`;
    const prev = existingByKey.get(key);

    if (!prev) {
      await db.insert(scoreEntry).values({
        playerId: r.playerId,
        fixtureId: r.fixtureId,
        rulesetVersion: ruleset.version,
        points: result.points,
        breakdown: result.breakdown,
      });
      summary.inserted += 1;
      continue;
    }

    if (
      prev.points === result.points &&
      breakdownEquals(prev.breakdown as ScoreBreakdown, result.breakdown)
    ) {
      summary.skipped += 1;
      continue;
    }

    await db
      .update(scoreEntry)
      .set({
        points: result.points,
        breakdown: result.breakdown,
        computedAt: new Date(),
      })
      .where(
        and(
          eq(scoreEntry.playerId, r.playerId),
          eq(scoreEntry.fixtureId, r.fixtureId),
          eq(scoreEntry.rulesetVersion, ruleset.version),
        ),
      );
    summary.updated += 1;
  }
  return summary;
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
      goalsConceded: statLine.goalsConceded,
      teamScoredInRegulationAndEt: statLine.teamScoredInRegulationAndEt,
      position: player.position,
    })
    .from(statLine)
    .innerJoin(player, eq(player.id, statLine.playerId))
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

  const summary = emptySummary();
  for (const r of rows) {
    const result = scoreStatLine(r, r.position, ruleset);
    const key = `${r.playerId}:${r.fixtureId}`;
    const prev = existingByKey.get(key);

    if (!prev) {
      await db.insert(scoreEntry).values({
        playerId: r.playerId,
        fixtureId: r.fixtureId,
        rulesetVersion: ruleset.version,
        points: result.points,
        breakdown: result.breakdown,
      });
      summary.inserted += 1;
      continue;
    }

    if (
      prev.points === result.points &&
      breakdownEquals(prev.breakdown as ScoreBreakdown, result.breakdown)
    ) {
      summary.skipped += 1;
      continue;
    }

    await db
      .update(scoreEntry)
      .set({
        points: result.points,
        breakdown: result.breakdown,
        computedAt: new Date(),
      })
      .where(
        and(
          eq(scoreEntry.playerId, r.playerId),
          eq(scoreEntry.fixtureId, r.fixtureId),
          eq(scoreEntry.rulesetVersion, ruleset.version),
        ),
      );
    summary.updated += 1;
  }
  return summary;
}

/** Cheap structural equality for ScoreBreakdown JSON. */
function breakdownEquals(a: ScoreBreakdown, b: ScoreBreakdown): boolean {
  return (
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
    a.goalsConcededByKeeper === b.goalsConcededByKeeper &&
    a.gameWon === b.gameWon
  );
}
