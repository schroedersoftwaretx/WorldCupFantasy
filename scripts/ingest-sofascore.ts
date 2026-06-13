/**
 * Manual SofaScore ingest — run whenever you want fresh scores. No cron, no
 * API key. Fetches through a real browser to get past Cloudflare.
 *
 *   # full pipeline: refresh schedule -> ingest newly-finished fixtures ->
 *   # recompute scores -> snapshot standings
 *   node --env-file=.env --import tsx scripts/ingest-sofascore.ts
 *
 *   # force a single fixture even if it already has stat lines (use the
 *   # SofaScore event id, i.e. the post-remap source_fixture_id)
 *   node --env-file=.env --import tsx scripts/ingest-sofascore.ts <eventId>
 *
 * Prereqs: run scripts/remap-to-sofascore.ts --apply first so the DB carries
 * SofaScore source ids, and set STATS_PROVIDER=sofascore.
 */
import { createDb, closeDb } from "../src/data/db/client.js";
import { ingestFixtureStats } from "../src/data/ingest/fixture-stats.js";
import { getUningestedFinishedFixtures } from "../src/data/ingest/pending.js";
import { ingestSchedule } from "../src/data/ingest/schedule.js";
import { recomputeAll } from "../src/data/scoring/recompute.js";
import { DEFAULT_RULESET } from "../src/data/scoring/ruleset.js";
import { captureAllStandingsSnapshots } from "../src/data/standings/snapshot.js";
import { createBrowserFetch, makeSofaProvider } from "./sofascore-browser-fetch.js";

const ONE_FIXTURE = process.argv[2]; // optional SofaScore event id

async function main() {
  const url = process.env["DIRECT_DATABASE_URL"] || process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL / DIRECT_DATABASE_URL not set");
  const db = createDb({ connectionString: url });

  console.log("Launching browser for SofaScore (set SOFA_HEADFUL=1 if it stalls)…");
  const browser = await createBrowserFetch();
  try {
    const provider = makeSofaProvider(process.env, browser.fetchImpl);

    // Our DB holds only the draft pool, so SofaScore returns stat lines for
    // players we don't track (undrafted). Skip them instead of aborting.
    const ingestOpts = { skipUnknownPlayers: true };

    if (ONE_FIXTURE) {
      const s = await ingestFixtureStats(db, provider, ONE_FIXTURE, ingestOpts);
      console.log(`fixture ${ONE_FIXTURE}: inserted=${s.inserted} updated=${s.updated} skipped=${s.skipped}`);
    } else {
      console.log("Refreshing schedule…");
      const sched = await ingestSchedule(db, provider);
      console.log(`schedule: ${JSON.stringify(sched)}`);

      const pending = await getUningestedFinishedFixtures(db);
      console.log(`stats: ${pending.length} newly-finished fixture(s) to ingest`);
      for (const fx of pending) {
        const s = await ingestFixtureStats(db, provider, fx.sourceFixtureId, ingestOpts);
        console.log(`  fx=${fx.sourceFixtureId} inserted=${s.inserted} updated=${s.updated} skipped=${s.skipped}`);
      }
    }

    const score = await recomputeAll(db, DEFAULT_RULESET);
    console.log(`scores: inserted=${score.inserted} updated=${score.updated} skipped=${score.skipped}`);

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
