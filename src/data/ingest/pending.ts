/**
 * Query helper: finished fixtures that have not yet been ingested.
 *
 * A fixture is considered "uningested" when it has status = FINISHED and
 * zero rows in stat_line. The ingest is idempotent, so ingesting an already-
 * covered fixture is safe, but skipping it here avoids unnecessary API calls.
 *
 * Used by:
 *   - CLI `ingest:all-finished` subcommand
 *   - Web cron `/api/cron/ingest-and-score`
 */
import { and, eq, notInArray } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { fixture, statLine, type FixtureRow } from "../db/schema.js";

/**
 * Return every FINISHED fixture that has no stat_line rows in the database.
 * Results are ordered by kickoff time ascending (oldest game first).
 */
export async function getUningestedFinishedFixtures(
  db: Db,
): Promise<FixtureRow[]> {
  // Fixture ids that already have at least one stat_line row.
  const coveredRows = await db
    .selectDistinct({ fixtureId: statLine.fixtureId })
    .from(statLine);
  const coveredIds = coveredRows.map((r) => r.fixtureId);

  if (coveredIds.length === 0) {
    // Nothing ingested yet -- every FINISHED fixture needs attention.
    return db
      .select()
      .from(fixture)
      .where(eq(fixture.status, "FINISHED"))
      .orderBy(fixture.kickoffUtc);
  }

  return db
    .select()
    .from(fixture)
    .where(
      and(
        eq(fixture.status, "FINISHED"),
        notInArray(fixture.id, coveredIds),
      ),
    )
    .orderBy(fixture.kickoffUtc);
}
