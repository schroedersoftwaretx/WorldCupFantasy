/**
 * Ingestion subcommands: squads, schedule, fixture stats, odds, rankings.
 */

import { eq } from "drizzle-orm";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { nationalTeam, player } from "../../data/db/schema.js";
import { ingestFixtureStats } from "../../data/ingest/fixture-stats.js";
import { getUningestedFinishedFixtures } from "../../data/ingest/pending.js";
import { ingestSchedule } from "../../data/ingest/schedule.js";
import { ingestSquads } from "../../data/ingest/squads.js";
import { oddsProviderFromEnv } from "../../data/odds/odds-provider.js";
import { stageOddsProviderFromEnv } from "../../data/odds/stage-odds-provider.js";
import { recomputeProjections } from "../../data/projection/recompute-projections.js";
import { resolveProviderName } from "../../data/provider/select.js";
import { recomputeAllRulesets } from "../../data/scoring/recompute.js";
import { DEFAULT_RULESET } from "../../data/scoring/ruleset.js";
import {
  formatSummary,
  lastName,
  nameScore,
  stripDiacritics,
  type Subcommand,
} from "../helpers.js";

export const ingestCommands: Record<string, Subcommand> = {
  "ingest:squads": async ({ db, getProvider }) => {
    const result = await ingestSquads(db, getProvider());
    console.log(`squads.teams   ${formatSummary(result.teams)}`);
    console.log(`squads.players ${formatSummary(result.players)}`);
  },
  "ingest:schedule": async ({ db, getProvider }) => {
    const summary = await ingestSchedule(db, getProvider());
    console.log(`schedule       ${formatSummary(summary)}`);
  },
  "ingest:fixture-stats": async ({ db, getProvider, args }) => {
    const sourceFixtureId = args[0];
    if (!sourceFixtureId) {
      throw new Error("usage: ingest:fixture-stats <sourceFixtureId>");
    }
    const summary = await ingestFixtureStats(db, getProvider(), sourceFixtureId);
    console.log(`stats fx=${sourceFixtureId} ${formatSummary(summary)}`);
  },
  "ingest:all-finished": async ({ db, getProvider }) => {
    const pending = await getUningestedFinishedFixtures(db);
    if (pending.length === 0) {
      console.log("nothing to do -- all FINISHED fixtures already have stats");
      return;
    }
    console.log(`ingesting stats for ${pending.length} fixture(s)...`);
    let ingested = 0;
    for (const fx of pending) {
      const summary = await ingestFixtureStats(db, getProvider(), fx.sourceFixtureId);
      console.log(`  fx=${fx.sourceFixtureId} stage=${fx.stage} ${JSON.stringify(summary)}`);
      ingested += 1;
    }
    console.log(`\ningested ${ingested} fixture(s) -- recomputing scores...`);
    const r = await recomputeAllRulesets(db);
    console.log(`score: ${r.rulesets} ruleset(s) ${formatSummary(r.total)}`);
  },
  "ingest:all": async ({ db, getProvider }) => {
    // One command, whichever source is configured (see STATS_PROVIDER).
    // Mirrors the Vercel cron: refresh schedule -> ingest newly-finished
    // fixtures -> recompute scores -> (if ODDS_API_KEY) odds + projections.
    const env = process.env as NodeJS.ProcessEnv;
    console.log(`provider: ${resolveProviderName(env)}`);

    const provider = getProvider();
    const sched = await ingestSchedule(db, provider);
    console.log(`schedule       ${formatSummary(sched)}`);

    const pending = await getUningestedFinishedFixtures(db);
    console.log(`stats: ${pending.length} newly-finished fixture(s) to ingest`);
    for (const fx of pending) {
      const summary = await ingestFixtureStats(db, provider, fx.sourceFixtureId);
      console.log(`  fx=${fx.sourceFixtureId} stage=${fx.stage} ${formatSummary(summary)}`);
    }

    const score = await recomputeAllRulesets(db);
    console.log(`score: ${score.rulesets} ruleset(s) ${formatSummary(score.total)}`);

    if (env["ODDS_API_KEY"]) {
      try {
        const oddsProvider = oddsProviderFromEnv(env);
        const odds = await oddsProvider.ingestOdds(db);
        console.log(`odds: fetched=${odds.fetched} matched=${odds.matched} skipped=${odds.skipped}`);
        const proj = await recomputeProjections(db, DEFAULT_RULESET);
        console.log(`projections: fixtures=${proj.fixturesProcessed} players=${proj.playersProjected}`);
        const stage = await stageOddsProviderFromEnv(env).ingestStageOdds(db);
        console.log(
          `stage-odds: fetched=${stage.stagesFetched} skipped=${stage.stagesSkipped} ` +
            `unavailable=${stage.stagesUnavailable} rows=${stage.rowsUpserted}`,
        );
      } catch (err) {
        console.error(`odds/projections skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log("ingest:all complete.");
  },
  "ingest:stage-odds": async ({ db }) => {
    const env = process.env as NodeJS.ProcessEnv;
    if (!env["ODDS_API_KEY"]) {
      throw new Error("ODDS_API_KEY is not set. Add it to your .env file.");
    }
    console.log("fetching stage (reach-round) odds from The Odds API...");
    const summary = await stageOddsProviderFromEnv(env).ingestStageOdds(db);
    console.log(
      `stage-odds: fetched=${summary.stagesFetched} skipped=${summary.stagesSkipped} ` +
        `unavailable=${summary.stagesUnavailable} rows=${summary.rowsUpserted}`,
    );
    if (summary.unmatched.length > 0) {
      console.log(`  unmatched teams: ${summary.unmatched.join(", ")}`);
    }
    if (summary.stagesFetched === 0 && summary.stagesSkipped === 0) {
      console.log(
        "  (no stage markets available -- check `GET /v4/sports` for the current WC " +
          "futures keys and override via STAGE_ODDS_MARKETS if needed)",
      );
    }
  },
  "ingest:odds": async ({ db }) => {
    const env = process.env as NodeJS.ProcessEnv;
    if (!env["ODDS_API_KEY"]) {
      throw new Error("ODDS_API_KEY is not set. Add it to your .env file.");
    }
    const oddsProvider = oddsProviderFromEnv(env);
    console.log("fetching odds from The Odds API...");
    const oddsSummary = await oddsProvider.ingestOdds(db);
    console.log(
      `odds: fetched=${oddsSummary.fetched} matched=${oddsSummary.matched} skipped=${oddsSummary.skipped}`,
    );
    if (oddsSummary.matched === 0 && oddsSummary.skipped === 0) {
      console.log(
        "  (no fixtures matched -- run ingest:schedule first, or check the tournament hasn't started yet)",
      );
      return;
    }
    console.log("recomputing projections...");
    const projSummary = await recomputeProjections(db, DEFAULT_RULESET);
    console.log(
      `projections: fixtures=${projSummary.fixturesProcessed} players=${projSummary.playersProjected} ruleset=${projSummary.rulesetVersion}`,
    );
  },
  "ingest:rankings": async ({ db, args }) => {
    const csvPath = args[0];
    if (!csvPath) {
      throw new Error("usage: ingest:rankings <path/to/draft_import.csv>");
    }

    // Known mismatches between the draft_import.csv country_name values
    // and the football-data.org names stored in our national_team table.
    const COUNTRY_ALIASES: Record<string, string> = {
      "usa":                      "united states",
      "united states":            "united states",
      "south korea":              "korea republic",
      "ivory coast":              "côte d'ivoire",
      "congo dr":                 "congo dr",
      "dr congo":                 "congo dr",
      // Czech Republic — football-data.org uses "Czechia" in recent data
      "czech republic":           "czechia",
      "czechia":                  "czech republic",
      // Bosnia — football-data.org uses "Bosnia-Herzegovina" (hyphen, no "and")
      "bosnia and herzegovina":   "bosnia-herzegovina",
      "bosnia & herzegovina":     "bosnia-herzegovina",
      "bosnia-herzegovina":       "bosnia and herzegovina",
    };

    // Read CSV into memory.
    const rows: Record<string, string>[] = [];
    await new Promise<void>((resolve, reject) => {
      const rl = createInterface({ input: createReadStream(csvPath), crlfDelay: Infinity });
      let headers: string[] = [];
      rl.on("line", (line) => {
        if (!headers.length) { headers = line.split(","); return; }
        const vals = line.split(",");
        const row: Record<string, string> = {};
        headers.forEach((h, i) => { row[h.trim()] = (vals[i] ?? "").trim(); });
        rows.push(row);
      });
      rl.on("close", resolve);
      rl.on("error", reject);
    });

    if (rows.length === 0) {
      console.log("CSV is empty — nothing to import.");
      return;
    }

    // Load all teams from DB, build name→id map (case-insensitive).
    const teams = await db.select({ id: nationalTeam.id, name: nationalTeam.name }).from(nationalTeam);
    const teamByName = new Map<string, number>();
    for (const t of teams) teamByName.set(t.name.toLowerCase().trim(), t.id);

    function resolveTeam(csvName: string): number | undefined {
      const key = csvName.toLowerCase().trim();
      // Never match an empty key — would incorrectly hit every team via includes("").
      if (!key) return undefined;
      // 1. Direct match.
      if (teamByName.has(key)) return teamByName.get(key);
      // 2. Alias map (also try the alias in the other direction).
      const alias = COUNTRY_ALIASES[key];
      if (alias && teamByName.has(alias)) return teamByName.get(alias);
      // 3. Substring match.
      for (const [dbName, id] of teamByName) {
        if (dbName.includes(key) || key.includes(dbName)) return id;
      }
      // 4. Word-overlap match — normalise hyphens and conjunctions so
      //    "Bosnia and Herzegovina" ≈ "Bosnia-Herzegovina",
      //    "United States" ≈ "USA" (after alias), etc.
      const keyWords = key.replace(/[-–—]/g, " ").replace(/\band\b/g, "").replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter((w) => w.length > 2);
      for (const [dbName, id] of teamByName) {
        const dbWords = dbName.replace(/[-–—]/g, " ").replace(/\band\b/g, "").replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter((w) => w.length > 2);
        if (keyWords.length === 0 || dbWords.length === 0) continue;
        const overlap = keyWords.filter((w) => dbWords.includes(w));
        if (overlap.length >= Math.min(keyWords.length, dbWords.length)) return id;
      }
      return undefined;
    }

    // Load all players, group by teamId.
    const players = await db
      .select({ id: player.id, fullName: player.fullName, nationalTeamId: player.nationalTeamId })
      .from(player);

    type PlayerEntry = { id: number; fullName: string };
    const playersByTeam = new Map<number, PlayerEntry[]>();
    for (const p of players) {
      const list = playersByTeam.get(p.nationalTeamId) ?? [];
      list.push({ id: p.id, fullName: p.fullName });
      playersByTeam.set(p.nationalTeamId, list);
    }

    let matched = 0;
    let skipped = 0;
    const noTeam: string[] = [];
    const noPlayer: string[] = [];

    for (const row of rows) {
      if (row["on_confirmed_squad"] !== "true") { skipped++; continue; }

      const adpRaw = Number(row["adp"]);
      const nameNorm = (row["name_normalized"] ?? "").toLowerCase();
      const countryName = row["country_name"] ?? "";
      const adp = Math.round(adpRaw);
      if (!adp || adp <= 0) { skipped++; continue; }

      // Resolve team with alias fallback.
      const teamId = resolveTeam(countryName);
      if (!teamId) {
        // When country is blank, try a global exact/high-confidence name search
        // across all teams (catches players whose CSV row has an empty country field).
        if (!countryName.trim()) {
          const allCandidates = [...playersByTeam.values()].flat();
          const fullNameRaw = row["full_name"] ?? "";
          const globalMatch =
            allCandidates.find((p) => stripDiacritics(p.fullName).toLowerCase() === stripDiacritics(fullNameRaw).toLowerCase()) ??
            allCandidates.find((p) => stripDiacritics(p.fullName).toLowerCase() === nameNorm) ??
            allCandidates.find((p) => nameScore(p.fullName, fullNameRaw) >= 0.9);
          if (globalMatch) {
            await db.update(player).set({ draftRank: adp, updatedAt: new Date() }).where(eq(player.id, globalMatch.id));
            console.log(`  rank=${adp.toString().padStart(4)}  ${globalMatch.fullName.padEnd(30)} <- ${fullNameRaw} [global]`);
            matched++;
            continue;
          }
        }
        noTeam.push(`${row["full_name"]} / ${countryName}`);
        skipped++;
        continue;
      }

      // Find best player match by name (normalized, diacritics stripped, then fuzzy).
      const candidates = playersByTeam.get(teamId) ?? [];
      const match =
        // 1. Exact normalized match
        candidates.find((p) => stripDiacritics(p.fullName) === stripDiacritics(row["full_name"] ?? "")) ??
        // 2. Normalized name from CSV field
        candidates.find((p) => stripDiacritics(p.fullName).toLowerCase() === nameNorm) ??
        // 3. Last-name match (handles "Raphinha" stored as "Raphinha" vs "R. Raphinha")
        candidates.find((p) => {
          const last = lastName(stripDiacritics(p.fullName));
          const csvLast = lastName(stripDiacritics(row["full_name"] ?? ""));
          return last.length > 2 && last === csvLast;
        }) ??
        // 4. High-confidence fuzzy match
        candidates.find((p) => nameScore(p.fullName, row["full_name"] ?? "") >= 0.75) ??
        // 5. Subset-name match: all words of the shorter name appear in the longer
        //    (e.g. "Jhon Cordoba" subset of "Jhon Emerson Cordoba Mosquera")
        candidates.find((p) => {
          const wa = stripDiacritics(p.fullName).toLowerCase().split(/\s+/).filter((w) => w.length > 1);
          const wb = stripDiacritics(row["full_name"] ?? "").toLowerCase().split(/\s+/).filter((w) => w.length > 1);
          const [shorter, longer] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
          return shorter.length >= 2 && shorter.every((w) => longer.includes(w));
        }) ??
        // 6. Relaxed fuzzy match — last resort
        candidates.find((p) => nameScore(p.fullName, row["full_name"] ?? "") >= 0.55);

      if (!match) {
        noPlayer.push(`${row["full_name"]} (${countryName})`);
        skipped++;
        continue;
      }

      await db.update(player).set({ draftRank: adp, updatedAt: new Date() }).where(eq(player.id, match.id));
      console.log(`  rank=${adp.toString().padStart(4)}  ${match.fullName.padEnd(30)} ← ${row["full_name"]}`);
      matched++;
    }

    if (noTeam.length > 0) {
      console.log("\n--- No team match (add to COUNTRY_ALIASES in cli/index.ts) ---");
      noTeam.forEach((s) => console.log(`  ${s}`));
    }
    if (noPlayer.length > 0) {
      console.log("\n--- No player match (use player:rank <sourcePlayerId> <rank> manually) ---");
      noPlayer.forEach((s) => console.log(`  ${s}`));
    }

    console.log(`\nDone: ${matched} ranked, ${skipped} skipped.`);
    if (matched > 0) {
      console.log("Run `ingest:odds` to recompute projections with the new rankings.");
    }
  },
};
