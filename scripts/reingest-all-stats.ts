/**
 * Force a FULL re-ingest of every finished fixture's stats from SofaScore.
 *
 * Unlike scripts/ingest-sofascore.ts (which only touches newly-finished
 * fixtures and skips any whose provider revision is unchanged), this rewrites
 * the stat_line rows for ALL finished fixtures — even ones already ingested.
 * Use it to backfill columns the mapping gained after the original ingest
 * (e.g. key_passes / big_chances_created), since the SofaScore revision for a
 * long-finished match never changes and would otherwise make the upsert a
 * no-op.
 *
 *   # re-ingest every finished fixture, then recompute + snapshot:
 *   node --env-file=.env --import tsx scripts/reingest-all-stats.ts
 *
 *   # skip the schedule refresh (faster; statuses already up to date):
 *   node --env-file=.env --import tsx scripts/reingest-all-stats.ts --no-schedule
 *
 * Manually-edited stat lines are ALWAYS preserved — the force flag respects the
 * manual-edit lock, so hand corrections are never clobbered.
 *
 * Prereqs: scripts/remap-to-sofascore.ts --apply has been run (so fixtures
 * carry SofaScore source ids) and STATS_PROVIDER=sofascore. Run the migration
 * that adds any new stat_line columns BEFORE this, or the writes will fail.
 */
import { eq } from "drizzle-orm";

import { createDb, closeDb } from "../src/data/db/client.js";
import { fixture } from "../src/data/db/schema.js";
import { ingestFixtureStats } from "../src/data/ingest/fixture-stats.js";
import { ingestSchedule } from "../src/data/ingest/schedule.js";
import { recomputeAllRulesets } from "../src/data/scoring/recompute.js";
import { captureAllStandingsSnapshots } from "../src/data/standings/snapshot.js";
import { createBrowserFetch, makeSofaProvider } from "./sofascore-browser-fetch.js";

const SKIP_SCHEDULE = process.argv.includes("--no-schedule");

async function main() {
  const url = process.env["DIRECT_DATABASE_URL"] || process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL / DIRECT_DATABASE_URL not set");
  const db = createDb({ connectionString: url });

  console.log("Launching browser for SofaScore (set SOFA_HEADFUL=1 if it stalls)…");
  const browser = await createBrowserFetch();
  try {
    const provider = makeSofaProvider(process.env, browser.fetchImpl);

    // Our DB holds only the draft pool, so SofaScore returns stat lines for
    // players we don't track (undrafted). Skip them rather than abort. `force`
    // makes the upsert overwrite rows whose revision is unchanged.
    const ingestOpts = { skipUnknownPlayers: true, force: true } as const;

    if (!SKIP_SCHEDULE) {
      console.log("Refreshing schedule…");
      const sched = await ingestSchedule(db, provider);
      console.log(`schedule: ${JSON.stringify(sched)}`);
    }

    const finished = await db
      .select()
      .from(fixture)
      .where(eq(fixture.status, "FINISHED"))
      .orderBy(fixture.kickoffUtc);
    console.log(`re-ingesting ${finished.length} finished fixture(s) (force overwrite)…`);

    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    for (const fx of finished) {
      try {
        const s = await ingestFixtureStats(db, provider, fx.sourceFixtureId, ingestOpts);
        inserted += s.inserted;
        updated += s.updated;
        skipped += s.skipped;
        console.log(
          `  fx=${fx.sourceFixtureId} inserted=${s.inserted} updated=${s.updated} skipped=${s.skipped}`,
        );
      } catch (e) {
        failed += 1;
        console.error(`  fx=${fx.sourceFixtureId} FAILED: ${e instanceof Error ? e.message : e}`);
      }
    }
    console.log(
      `stats: inserted=${inserted} updated=${updated} skipped=${skipped} failed=${failed}`,
    );

    const score = await recomputeAllRulesets(db);
    console.log(
      `scores: ${score.rulesets} ruleset(s) — inserted=${score.total.inserted} updated=${score.total.updated} skipped=${score.total.skipped}`,
    );

    const snaps = await captureAllStandingsSnapshots(db);
    console.log(`snapshots: ${JSON.stringify(snaps)}`);
    console.log("done.");
  } finally {
    await browser.close();
    await closeDb(db);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
