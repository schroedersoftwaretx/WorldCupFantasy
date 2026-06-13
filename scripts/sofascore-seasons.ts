/**
 * Discover SofaScore season ids for a unique tournament (default: World Cup =
 * 16), so we can set the correct SOFASCORE_SEASON_ID. Also probes each recent
 * season's standings so we can see which one actually has teams seeded.
 *
 *   $env:SOFA_HEADFUL=1
 *   node --env-file=.env --import tsx scripts/sofascore-seasons.ts
 */
import { createBrowserFetch } from "./sofascore-browser-fetch.js";

const UT = Number(process.env["SOFASCORE_TOURNAMENT_ID"] ?? 16);
const BASE = "https://www.sofascore.com/api/v1";

async function main() {
  console.log(`Discovering seasons for unique-tournament ${UT}…`);
  const browser = await createBrowserFetch();
  try {
    const r = await browser.fetchImpl(`${BASE}/unique-tournament/${UT}/seasons`);
    const json: any = await (r as any).json();
    const seasons: Array<{ id: number; year: string; name: string }> = json.seasons ?? [];
    if (!seasons.length) {
      console.log("No seasons returned. Raw body:");
      console.log((await (r as any).text()).slice(0, 500));
      return;
    }
    console.log(`\n${seasons.length} seasons found. Most recent first:\n`);
    console.table(seasons.slice(0, 12).map((s) => ({ id: s.id, year: s.year, name: s.name })));

    // Probe the newest few for seeded standings (which fetchSquads relies on).
    console.log("\nProbing standings for the newest seasons (looking for one with teams):");
    for (const s of seasons.slice(0, 6)) {
      try {
        const sr = await browser.fetchImpl(
          `${BASE}/unique-tournament/${UT}/season/${s.id}/standings/total`,
        );
        const sj: any = await (sr as any).json();
        const groups = sj.standings ?? [];
        const teamCount = groups.reduce((n: number, g: any) => n + (g.rows?.length ?? 0), 0);
        console.log(`  season ${s.id} (${s.year}): ${groups.length} group(s), ${teamCount} team rows`);
      } catch (e) {
        console.log(`  season ${s.id} (${s.year}): standings error — ${e instanceof Error ? e.message : e}`);
      }
    }
    console.log(
      "\nPick the 2026 season with team rows and set it in .env:\n  SOFASCORE_SEASON_ID=<that id>",
    );
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
