/**
 * Verify the API-Football key + plan cover WC 2026 with the data the v2
 * ruleset needs (lineups + per-player statistics).
 *
 *   node --env-file=.env --import tsx scripts/check-apifootball-coverage.ts
 *
 * Reads only. Prints plan/quota and the coverage flags for league 1 / 2026.
 */
const KEY = process.env["API_FOOTBALL_KEY"];
const BASE = process.env["API_FOOTBALL_BASE_URL"] ?? "https://v3.football.api-sports.io";
const LEAGUE = Number(process.env["WORLDCUP_LEAGUE_ID"] ?? 1);
const SEASON = Number(process.env["WORLDCUP_SEASON"] ?? 2026);

if (!KEY) { console.error("API_FOOTBALL_KEY not set"); process.exit(1); }

async function get(path: string): Promise<any> {
  const r = await fetch(`${BASE}${path}`, { headers: { "x-apisports-key": KEY! } });
  const j = await r.json();
  if (j.errors && Object.keys(j.errors).length) console.log(`  errors: ${JSON.stringify(j.errors)}`);
  return j;
}

console.log(`Base ${BASE} | league ${LEAGUE} | season ${SEASON}\n`);

const status = await get("/status");
const acct = status.response?.account, sub = status.response?.subscription, req = status.response?.requests;
console.log("=== PLAN ===");
console.log(`  account : ${acct?.firstname ?? "?"} (${acct?.email ?? "?"})`);
console.log(`  plan    : ${sub?.plan ?? "?"}  active=${sub?.active}  ends=${sub?.end ?? "?"}`);
console.log(`  requests: ${req?.current ?? "?"} / ${req?.limit_day ?? "?"} today\n`);

const leagues = await get(`/leagues?id=${LEAGUE}&season=${SEASON}`);
const entry = leagues.response?.[0];
if (!entry) {
  console.log(`No league ${LEAGUE} / season ${SEASON} on this plan -> WC 2026 NOT covered.`);
  console.log("Confirm the league id (search /leagues?search=World Cup) and that your plan includes current seasons.");
  process.exit(0);
}
const seasonObj = entry.seasons?.find((s: any) => s.year === SEASON);
const cov = seasonObj?.coverage;
console.log(`=== COVERAGE for "${entry.league?.name}" ${SEASON} ===`);
console.log(`  fixtures.lineups            : ${cov?.fixtures?.lineups}`);
console.log(`  fixtures.statistics_players : ${cov?.fixtures?.statistics_players}`);
console.log(`  fixtures.events             : ${cov?.fixtures?.events}`);
console.log(`  players                     : ${cov?.players}`);
console.log(`  standings                   : ${cov?.standings}`);

const ok = cov?.fixtures?.lineups && cov?.fixtures?.statistics_players;
console.log(`\n=> ${ok ? "GOOD: lineups + per-player stats are covered. API-Football is viable." :
  "INSUFFICIENT: lineups and/or per-player statistics are NOT covered on this plan/season."}`);
