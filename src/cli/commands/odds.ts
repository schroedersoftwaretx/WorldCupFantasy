/**
 * Odds-market diagnostics and provider connectivity checks.
 */

import { stageOddsProviderFromEnv } from "../../data/odds/stage-odds-provider.js";
import type { Subcommand } from "../helpers.js";

export const oddsCommands: Record<string, Subcommand> = {
  "odds:sports": async () => {
    const env = process.env as NodeJS.ProcessEnv;
    if (!env["ODDS_API_KEY"]) {
      throw new Error("ODDS_API_KEY is not set. Add it to your .env file.");
    }
    const sports = await stageOddsProviderFromEnv(env).listSports();
    const wc = sports.filter(
      (s) => /world.?cup/i.test(s.key) || /world cup/i.test(s.title),
    );
    console.log(`World Cup markets (${wc.length}):`);
    if (wc.length === 0) {
      console.log("  (none found -- the WC may be out of season on your plan)");
    }
    for (const s of wc) {
      const flags = [
        s.has_outrights ? "outrights" : "",
        s.active ? "active" : "inactive",
      ]
        .filter(Boolean)
        .join(", ");
      console.log(`  ${s.key}  [${flags}]  ${s.title}`);
    }
    const otherSoccer = sports.filter(
      (s) => s.group === "Soccer" && !wc.includes(s),
    );
    console.log(`\nOther soccer markets (${otherSoccer.length}) -- run with --all to list:`);
    if (process.argv.includes("--all")) {
      for (const s of otherSoccer) console.log(`  ${s.key}  ${s.title}`);
    }
    console.log(
      "\nUse the keys above with has_outrights=true to set STAGE_ODDS_MARKETS, e.g.\n" +
        '  STAGE_ODDS_MARKETS=[{"stage":"CHAMPION","sportKey":"soccer_fifa_world_cup_winner","slots":1}]',
    );
  },
  "provider:test": async ({ getProvider }) => {
    // Diagnostic: verify API connectivity and report raw result counts.
    // Run this first if ingest:squads returns all zeros.
    const provider = getProvider();
    // Access internal cfg via cast to inspect what league/season we're hitting.
    const cfg = (provider as unknown as { cfg: { leagueId: number; season: number; baseUrl: string } }).cfg;
    console.log(`provider: ${cfg.baseUrl}  league=${cfg.leagueId}  season=${cfg.season}`);
    console.log("fetching squads (this calls /standings then /teams then /players/squads per team)...");
    try {
      const squads = await provider.fetchSquads();
      console.log(`fetchSquads => ${squads.length} team(s)`);
      if (squads.length > 0) {
        const totalPlayers = squads.reduce((n, s) => n + s.players.length, 0);
        console.log(`  sample team: ${squads[0]!.team.name}  players: ${squads[0]!.players.length}`);
        console.log(`  total players across all teams: ${totalPlayers}`);
      }
    } catch (err) {
      console.error("fetchSquads FAILED:", err instanceof Error ? err.message : String(err));
    }
  },
};
