/**
 * Diagnose why a national team shows as eliminated / alive.
 *
 *   node --env-file=.env --import tsx scripts/diagnose-alive.ts England
 *
 * Prints the team's stored status, every fixture it's in (stage / status /
 * reg+ET score), and the derived alive verdict, so you can see whether the
 * "eliminated" flag is a data gap (missing score, unfinished status) or the
 * penalty-shootout inference in src/web/alive.ts.
 */
import { sql } from "drizzle-orm";
import { createDb, closeDb } from "../src/data/db/client.js";
import { getTournamentAliveState } from "../src/web/alive.js";

async function main() {
  const name = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "England";
  const url = process.env["DIRECT_DATABASE_URL"] || process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL / DIRECT_DATABASE_URL not set");
  const db = createDb({ connectionString: url });
  try {
    const { rows: teams } = await db.execute(sql`
      SELECT id, name, status, group_label FROM national_team
      WHERE name ILIKE ${"%" + name + "%"} ORDER BY name;`);
    if (teams.length === 0) { console.log(`No national team matching "${name}".`); return; }

    const alive = await getTournamentAliveState(db);
    console.log(`started: ${alive.started}\n`);

    for (const t of teams as any[]) {
      console.log(`=== ${t.name} (id ${t.id}) ===`);
      console.log(`  national_team.status = ${t.status}   group = ${t.group_label ?? "-"}`);
      console.log(`  DERIVED alive = ${alive.aliveByTeamId.get(t.id)}  (eliminated flag = ${!(alive.aliveByTeamId.get(t.id) ?? true)})`);
      const { rows: fx } = await db.execute(sql`
        SELECT f.stage, f.status, f.source_fixture_id AS event_id,
               h.name AS home, a.name AS away, f.home_score, f.away_score,
               f.kickoff_utc
        FROM fixture f
        JOIN national_team h ON h.id = f.home_team_id
        JOIN national_team a ON a.id = f.away_team_id
        WHERE f.home_team_id = ${t.id} OR f.away_team_id = ${t.id}
        ORDER BY f.kickoff_utc;`);
      console.log(`  fixtures (${fx.length}):`);
      for (const r of fx as any[]) {
        const sc = r.home_score == null && r.away_score == null ? "no score" : `${r.home_score}-${r.away_score}`;
        console.log(`    ${String(r.stage).padEnd(11)} ${String(r.status).padEnd(9)} ${r.home} vs ${r.away}  ${sc}  (event ${r.event_id})`);
      }
      console.log("");
    }
    console.log("Reading: won knockout on SCORE -> alive. Level score (penalties) -> alive only");
    console.log("if a later round names the team, else shows eliminated. NULL score (failed");
    console.log("ingest) also looks 'level' and can wrongly eliminate a winner -> re-ingest that fixture.");
  } finally {
    await closeDb(db);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
