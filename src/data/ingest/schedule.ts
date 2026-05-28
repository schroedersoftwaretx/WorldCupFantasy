/**
 * Schedule ingestion.
 *
 * Upserts the `fixture` table from a StatsProvider.fetchSchedule() result.
 * Idempotent — re-runs produce identical state and report skipped rows.
 *
 * If a fixture references a national team that hasn't been ingested yet,
 * we fail loudly. This prevents silently creating a fixture without home
 * or away references; callers should run `ingest:squads` first.
 */

import { eq } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { fixture, nationalTeam, type FixtureRow } from "../db/schema.js";
import { ProviderMappingError } from "../provider/types.js";
import type { ProviderFixture, StatsProvider } from "../provider/types.js";
import { emptySummary, type IngestSummary } from "./summary.js";

export async function ingestSchedule(
  db: Db,
  provider: StatsProvider,
): Promise<IngestSummary> {
  const fixtures = await provider.fetchSchedule();
  return upsertFixtures(db, fixtures);
}

async function upsertFixtures(
  db: Db,
  fixtures: ProviderFixture[],
): Promise<IngestSummary> {
  const summary = emptySummary();
  const teamRows = await db.select().from(nationalTeam);
  const teamIdBySource = new Map(teamRows.map((r) => [r.sourceTeamId, r.id]));

  const existing = await db.select().from(fixture);
  const byId = new Map<string, FixtureRow>(existing.map((r) => [r.sourceFixtureId, r]));

  for (const f of fixtures) {
    const homeId = teamIdBySource.get(f.sourceHomeTeamId);
    const awayId = teamIdBySource.get(f.sourceAwayTeamId);
    if (homeId == null || awayId == null) {
      throw new ProviderMappingError(
        `cannot ingest fixture ${f.sourceFixtureId}: missing team(s) ` +
          `home=${f.sourceHomeTeamId} away=${f.sourceAwayTeamId}. Run ingest:squads first.`,
      );
    }

    const row = byId.get(f.sourceFixtureId);
    if (!row) {
      await db.insert(fixture).values({
        sourceFixtureId: f.sourceFixtureId,
        stage: f.stage,
        homeTeamId: homeId,
        awayTeamId: awayId,
        kickoffUtc: f.kickoffUtc,
        status: f.status,
        homeScore: f.homeScore,
        awayScore: f.awayScore,
      });
      summary.inserted += 1;
      continue;
    }

    const changed =
      row.stage !== f.stage ||
      row.homeTeamId !== homeId ||
      row.awayTeamId !== awayId ||
      row.kickoffUtc.getTime() !== f.kickoffUtc.getTime() ||
      row.status !== f.status ||
      row.homeScore !== f.homeScore ||
      row.awayScore !== f.awayScore;
    if (!changed) {
      summary.skipped += 1;
      continue;
    }
    await db
      .update(fixture)
      .set({
        stage: f.stage,
        homeTeamId: homeId,
        awayTeamId: awayId,
        kickoffUtc: f.kickoffUtc,
        status: f.status,
        homeScore: f.homeScore,
        awayScore: f.awayScore,
        updatedAt: new Date(),
      })
      .where(eq(fixture.id, row.id));
    summary.updated += 1;
  }

  return summary;
}
