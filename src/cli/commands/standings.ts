/**
 * League standings subcommand.
 */

import { computeStandings } from "../../data/standings/standings.js";
import type { Subcommand } from "../helpers.js";

export const standingsCommands: Record<string, Subcommand> = {
  "standings:show": async ({ db, args }) => {
    const [leagueIdRaw, verboseRaw] = args;
    if (!leagueIdRaw) throw new Error("usage: standings:show <leagueId> [--periods]");
    const verbose = verboseRaw === "--periods";
    const standings = await computeStandings(db, Number(leagueIdRaw));
    if (standings.length === 0) {
      console.log("(no teams in this league)");
      return;
    }
    console.log("rank  total  team");
    for (const e of standings) {
      console.log(
        `${String(e.rank).padStart(4)}  ${String(e.total).padStart(5)}  ${e.teamName}`,
      );
      if (verbose) {
        for (const p of e.periods) {
          if (p.points > 0) {
            console.log(`         ${p.stage.padEnd(12)} ${p.formation}  ${p.points} pts`);
          }
        }
      }
    }
  },
};
