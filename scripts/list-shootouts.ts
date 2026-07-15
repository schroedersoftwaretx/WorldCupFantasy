/**
 * List knockout fixtures that went to a penalty shootout.
 *
 * A knockout match cannot end level, and fixture.home_score / away_score store
 * the regulation+ET score (shootout goals excluded). So any FINISHED knockout
 * fixture whose two scores are equal was decided on penalties.
 *
 * For each one it prints the SofaScore event id (source_fixture_id) and whether
 * the shootout columns are already populated in stat_line — i.e. whether it
 * still needs a `--force` re-ingest to backfill the keeper win bonus.
 *
 *   node --env-file=.env --import tsx scripts/list-shootouts.ts
 */
import { sql } from "drizzle-orm";
import { createDb, closeDb } from "../src/data/db/client.js";

async function main() {
  const url = process.env["DIRECT_DATABASE_URL"] || process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL / DIRECT_DATABASE_URL not set");
  const db = createDb({ connectionString: url });
  try {
    const { rows } = await db.execute(sql`
      SELECT f.source_fixture_id                         AS event_id,
             f.stage,
             h.name                                      AS home,
             a.name                                      AS away,
             f.home_score, f.away_score,
             COALESCE(SUM(s.team_shootout_scored + s.team_shootout_conceded), 0) AS shootout_data
      FROM fixture f
      JOIN national_team h ON h.id = f.home_team_id
      JOIN national_team a ON a.id = f.away_team_id
      LEFT JOIN stat_line s ON s.fixture_id = f.id
      WHERE f.status = 'FINISHED'
        AND f.stage IN ('R32','R16','QF','SF','THIRD_PLACE','FINAL')
        AND f.home_score = f.away_score
      GROUP BY f.id, h.name, a.name
      ORDER BY f.kickoff_utc;
    `);

    if (rows.length === 0) {
      console.log("No knockout fixtures level after ET yet (no shootouts, or none finished).");
      return;
    }
    console.log(`${rows.length} shootout fixture(s):\n`);
    const needForce: string[] = [];
    for (const r of rows as any[]) {
      const has = Number(r.shootout_data) > 0;
      if (!has) needForce.push(String(r.event_id));
      console.log(
        `  ${String(r.event_id).padEnd(10)} ${String(r.stage).padEnd(11)} ` +
        `${r.home} ${r.home_score}-${r.away_score} ${r.away}  ` +
        `${has ? "shootout data: OK" : "shootout data: MISSING -> needs --force"}`,
      );
    }
    if (needForce.length > 0) {
      console.log(`\nRe-ingest the missing ones (one browser session each):`);
      for (const id of needForce) {
        console.log(`  node --env-file=.env --import tsx scripts/ingest-sofascore.ts ${id} --force`);
      }
    }
  } finally {
    await closeDb(db);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
