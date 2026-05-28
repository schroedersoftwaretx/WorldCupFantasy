/**
 * Per-fixture stats ingestion.
 *
 * For a single finished fixture, fetch per-player raw stats from the
 * provider and upsert into the immutable `stat_line` table.
 *
 * Idempotency rules:
 *   - One row per (player_id, fixture_id), enforced by the primary key.
 *   - An incoming row replaces the existing one ONLY when its
 *     `source_revision` is lexicographically >= the stored revision.
 *     This way a stale re-run (older revision) is a no-op (skipped),
 *     and a provider correction (newer revision) cleanly overwrites.
 *
 * `stat_line` is the source of truth for downstream scoring; we never
 * apply heuristic edits here, only upserts of provider-supplied data.
 */

import { and, eq } from "drizzle-orm";

import type { Db } from "../db/client.js";
import {
  fixture,
  player,
  statLine,
  type FixtureRow,
  type PlayerRow,
  type StatLineRow,
} from "../db/schema.js";
import {
  ProviderMappingError,
  type ProviderStatLine,
  type StatsProvider,
} from "../provider/types.js";
import { emptySummary, type IngestSummary } from "./summary.js";

export async function ingestFixtureStats(
  db: Db,
  provider: StatsProvider,
  sourceFixtureId: string,
): Promise<IngestSummary> {
  const lines = await provider.fetchFixtureStats(sourceFixtureId);

  // Resolve the internal fixture id once.
  const [fxRow] = (await db
    .select()
    .from(fixture)
    .where(eq(fixture.sourceFixtureId, sourceFixtureId))) as FixtureRow[];
  if (!fxRow) {
    throw new ProviderMappingError(
      `fixture ${sourceFixtureId} not present in DB. Run ingest:schedule first.`,
    );
  }

  return upsertStatLines(db, fxRow.id, lines);
}

async function upsertStatLines(
  db: Db,
  fixtureId: number,
  lines: ProviderStatLine[],
): Promise<IngestSummary> {
  const summary = emptySummary();

  // Build a sourcePlayerId → internal player id index in one query.
  const playerRows = (await db.select().from(player)) as PlayerRow[];
  const playerIdBySource = new Map<string, number>();
  for (const r of playerRows) playerIdBySource.set(r.sourcePlayerId, r.id);

  // Pre-load existing stat_line rows for this fixture so we can decide insert vs update.
  const existingRows = (await db
    .select()
    .from(statLine)
    .where(eq(statLine.fixtureId, fixtureId))) as StatLineRow[];
  const existingByPlayerId = new Map<number, StatLineRow>(
    existingRows.map((r) => [r.playerId, r]),
  );

  for (const line of lines) {
    const playerId = playerIdBySource.get(line.sourcePlayerId);
    if (playerId == null) {
      throw new ProviderMappingError(
        `stat line references unknown player ${line.sourcePlayerId}. ` +
          `Run ingest:squads first.`,
      );
    }

    const existing = existingByPlayerId.get(playerId);
    if (!existing) {
      await db.insert(statLine).values({
        playerId,
        fixtureId,
        minutesPlayed: line.minutesPlayed,
        goals: line.goals,
        assists: line.assists,
        saves: line.saves,
        yellowCards: line.yellowCards,
        redCards: line.redCards,
        penaltiesScored: line.penaltiesScored,
        penaltiesMissed: line.penaltiesMissed,
        penaltiesSaved: line.penaltiesSaved,
        ownGoals: line.ownGoals,
        teamConcededInRegulationAndEt: line.teamConcededInRegulationAndEt,
        sourceRevision: line.sourceRevision,
      });
      summary.inserted += 1;
      continue;
    }

    // Same-or-older revision is a no-op. This is what makes re-running with
    // the same provider data idempotent.
    if (line.sourceRevision < existing.sourceRevision) {
      summary.skipped += 1;
      continue;
    }
    if (line.sourceRevision === existing.sourceRevision) {
      // Same revision and presumably same data; nothing to do.
      summary.skipped += 1;
      continue;
    }

    // Newer revision — overwrite the entire row.
    await db
      .update(statLine)
      .set({
        minutesPlayed: line.minutesPlayed,
        goals: line.goals,
        assists: line.assists,
        saves: line.saves,
        yellowCards: line.yellowCards,
        redCards: line.redCards,
        penaltiesScored: line.penaltiesScored,
        penaltiesMissed: line.penaltiesMissed,
        penaltiesSaved: line.penaltiesSaved,
        ownGoals: line.ownGoals,
        teamConcededInRegulationAndEt: line.teamConcededInRegulationAndEt,
        sourceRevision: line.sourceRevision,
        ingestedAt: new Date(),
      })
      .where(and(eq(statLine.playerId, playerId), eq(statLine.fixtureId, fixtureId)));
    summary.updated += 1;
  }

  return summary;
}
