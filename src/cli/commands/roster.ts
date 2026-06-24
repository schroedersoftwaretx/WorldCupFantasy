/**
 * Roster add/show subcommands.
 */

import { eq } from "drizzle-orm";

import { fantasyTeam } from "../../data/db/schema.js";
import { addPlayerToRoster, getRoster, getRosterCounts } from "../../data/roster/service.js";
import { playerBySourceId, type Subcommand } from "../helpers.js";

export const rosterCommands: Record<string, Subcommand> = {
  "roster:add": async ({ db, args }) => {
    const [teamIdRaw, sourcePlayerId] = args;
    if (!teamIdRaw || !sourcePlayerId) {
      throw new Error("usage: roster:add <fantasyTeamId> <sourcePlayerId>");
    }
    const p = await playerBySourceId(db, sourcePlayerId);
    const result = await addPlayerToRoster(db, {
      fantasyTeamId: Number(teamIdRaw),
      playerId: p.id,
    });
    const c = result.counts;
    console.log(
      `drafted ${p.fullName} (${p.position}) -> team ${teamIdRaw}  ` +
        `[GK ${c.GK} DEF ${c.DEF} MID ${c.MID} FWD ${c.FWD}]`,
    );
  },
  "roster:show": async ({ db, args }) => {
    const [teamIdRaw] = args;
    if (!teamIdRaw) throw new Error("usage: roster:show <fantasyTeamId>");
    const teamId = Number(teamIdRaw);
    const [team] = await db.select().from(fantasyTeam).where(eq(fantasyTeam.id, teamId));
    if (!team) throw new Error(`no fantasy team with id ${teamId}`);
    const roster = await getRoster(db, teamId);
    const counts = await getRosterCounts(db, teamId);
    console.log(`team id=${team.id} name="${team.name}"  (${roster.length}/23 players)`);
    console.log(`  GK ${counts.GK}  DEF ${counts.DEF}  MID ${counts.MID}  FWD ${counts.FWD}`);
    for (const entry of roster) {
      console.log(`  ${entry.player.position.padEnd(3)} ${entry.player.fullName}`);
    }
  },
};
