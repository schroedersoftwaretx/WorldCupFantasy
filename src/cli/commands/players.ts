/**
 * Player ranking subcommand.
 */

import { eq } from "drizzle-orm";

import { player } from "../../data/db/schema.js";
import { playerBySourceId, type Subcommand } from "../helpers.js";

export const playersCommands: Record<string, Subcommand> = {
  "player:rank": async ({ db, args }) => {
    const [sourcePlayerId, rankRaw] = args;
    if (!sourcePlayerId || rankRaw === undefined) {
      throw new Error("usage: player:rank <sourcePlayerId> <rank>");
    }
    const p = await playerBySourceId(db, sourcePlayerId);
    await db
      .update(player)
      .set({ draftRank: Number(rankRaw), updatedAt: new Date() })
      .where(eq(player.id, p.id));
    console.log(`set draft_rank=${rankRaw} for ${p.fullName}`);
  },
};
