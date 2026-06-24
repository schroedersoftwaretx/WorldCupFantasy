/**
 * Manager + league management subcommands.
 */

import {
  acceptInvite,
  createLeague,
  createManager,
  inviteManager,
} from "../../data/league/service.js";
import { managerByUid, type Subcommand } from "../helpers.js";

export const leaguesCommands: Record<string, Subcommand> = {
  "manager:create": async ({ db, args }) => {
    const [uid, displayName, email] = args;
    if (!uid || !displayName || !email) {
      throw new Error("usage: manager:create <firebaseUid> <displayName> <email>");
    }
    const m = await createManager(db, { firebaseUid: uid, displayName, email });
    console.log(`manager id=${m.id} uid=${m.firebaseUid} name=${m.displayName}`);
  },
  "league:create": async ({ db, args }) => {
    const [ownerUid, name, maxRaw] = args;
    if (!ownerUid || !name) {
      throw new Error("usage: league:create <ownerFirebaseUid> <name> [maxManagers]");
    }
    const owner = await managerByUid(db, ownerUid);
    const result = await createLeague(db, {
      ownerManagerId: owner.id,
      name,
      ...(maxRaw ? { maxManagers: Number(maxRaw) } : {}),
    });
    console.log(
      `league id=${result.league.id} name="${result.league.name}" ` +
        `max=${result.league.maxManagers}`,
    );
    console.log(`owner team id=${result.ownerTeam.id} name="${result.ownerTeam.name}"`);
  },
  "league:invite": async ({ db, args }) => {
    const [leagueIdRaw, email] = args;
    if (!leagueIdRaw) throw new Error("usage: league:invite <leagueId> [email]");
    const invite = await inviteManager(db, {
      leagueId: Number(leagueIdRaw),
      ...(email ? { email } : {}),
    });
    console.log(`invite id=${invite.id} token=${invite.token}`);
  },
  "league:join": async ({ db, args }) => {
    const [token, managerUid] = args;
    if (!token || !managerUid) {
      throw new Error("usage: league:join <token> <managerFirebaseUid>");
    }
    const m = await managerByUid(db, managerUid);
    const result = await acceptInvite(db, { token, managerId: m.id });
    console.log(
      `joined league id=${result.league.id} name="${result.league.name}" ` +
        `as team id=${result.team.id}`,
    );
  },
};
