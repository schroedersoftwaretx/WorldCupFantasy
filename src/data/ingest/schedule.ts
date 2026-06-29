/**
 * Schedule ingestion.
 *
 * Upserts the `fixture` table from a StatsProvider.fetchSchedule() result.
 * Idempotent — re-runs produce identical state and report skipped rows.
 *
 * If a fixture references a national team that isn't in the DB — either a
 * TBD knockout slot (the provider sends an unresolved team id before the
 * bracket fills in) or a genuinely un-ingested squad — we skip that fixture
 * and report it, rather than aborting the whole run. The fixture is upserted
 * automatically on a later run once both teams resolve.
 */

import { eq } from "drizzle-orm";
import { logger } from "../../log.js";

import type { Db } from "../db/client.js";
import { fixture, nationalTeam, type FixtureRow } from "../db/schema.js";
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

  const unresolved: string[] = [];

  for (const f of fixtures) {
    const homeId = teamIdBySource.get(f.sourceHomeTeamId);
    const awayId = teamIdBySource.get(f.sourceAwayTeamId);
    if (homeId == null || awayId == null) {
      // TBD knockout slot (provider sends an unresolved/"null" team id before
      // the bracket fills in) or a genuinely un-ingested squad. Skip it for now
      // rather than aborting the whole ingest; it upserts on a later run once
      // both teams resolve.
      unresolved.push(
        `${f.sourceFixtureId} (home=${f.sourceHomeTeamId} away=${f.sourceAwayTeamId})`,
      );
      summary.skipped += 1;
      continue;
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

  if (unresolved.length > 0) {
    logger.warn("schedule: skipped fixtures with unresolved teams", {
      count: unresolved.length,
      reason: "TBD knockout slots or un-ingested squads",
      fixtures: unresolved,
    });
  }

  return summary;
}
