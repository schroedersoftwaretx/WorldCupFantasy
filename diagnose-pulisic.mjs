/**
 * One-off diagnostic: trace a player through the stat -> score pipeline.
 *   node --env-file=.env diagnose-pulisic.mjs            (defaults to "pulisic")
 *   node --env-file=.env diagnose-pulisic.mjs "messi"
 *
 * Reads only. Tells you WHY a score isn't updating without changing anything.
 */
import pg from "pg";

const NAME = (process.argv[2] ?? "pulisic").toLowerCase();
const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
const c = new pg.Client({ connectionString: url });
await c.connect();

const players = (await c.query(
  `select id, full_name, position, source_player_id, national_team_id, status
     from player where lower(full_name) like $1 order by id`,
  [`%${NAME}%`],
)).rows;

console.log(`\n# player rows matching "${NAME}"`);
console.table(players);

if (players.length === 0) {
  console.log("No player row. The provider's stat line can't map to anyone -> ingest throws/no score.");
  await c.end(); process.exit(0);
}
if (players.length > 1) {
  console.log("MULTIPLE player rows. Stats/roster may point at different ids -> looks 'not updated'.");
}

for (const p of players) {
  console.log(`\n=== player id=${p.id} (${p.full_name}) src=${p.source_player_id} ===`);

  const lines = (await c.query(
    `select s.fixture_id, f.source_fixture_id, f.status as fixture_status,
            f.kickoff_utc, s.minutes_played, s.goals, s.assists,
            s.source_revision, s.manually_edited, s.ingested_at
       from stat_line s join fixture f on f.id = s.fixture_id
      where s.player_id = $1 order by f.kickoff_utc`,
    [p.id],
  )).rows;
  console.log("stat_line rows:");
  console.table(lines);

  const scores = (await c.query(
    `select fixture_id, ruleset_version, points, computed_at
       from score_entry where player_id = $1 order by fixture_id`,
    [p.id],
  )).rows;
  console.log("score_entry rows:");
  console.table(scores);

  // Finished fixtures involving this player's team that have NO stat line for them.
  const missing = (await c.query(
    `select f.id, f.source_fixture_id, f.status, f.kickoff_utc,
            (select count(*) from stat_line sl where sl.fixture_id = f.id) as total_lines_in_fixture
       from fixture f
      where f.status = 'FINISHED'
        and (f.home_team_id = $1 or f.away_team_id = $1)
        and not exists (select 1 from stat_line s where s.fixture_id = f.id and s.player_id = $2)
      order by f.kickoff_utc`,
    [p.national_team_id, p.id],
  )).rows;
  console.log("FINISHED fixtures for this team with NO stat_line for the player:");
  console.table(missing);
}

await c.end();
