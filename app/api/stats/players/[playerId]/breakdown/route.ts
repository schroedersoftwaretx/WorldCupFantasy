/**
 * GET /api/stats/players/[playerId]/breakdown  (public)
 *
 * The per-rule, per-fixture score breakdown for one player, scored against
 * HUB_RULESET_VERSION (the same ruleset the rest of the public Stats Hub
 * reports against). Powers the click-through player modal on the public stats
 * surfaces (Team of the Stage pitch, leaderboards, Player Explorer).
 */
import { getPlayerBreakdownForRuleset } from "@/data/standings/player-breakdown";
import { handle, HttpError, parseId } from "@/web/api";
import { getDb } from "@/web/db";
import { HUB_RULESET_VERSION } from "@/web/stats-params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(
  request: Request,
  ctx: { params: Promise<{ playerId: string }> },
): Promise<Response> {
  return handle(async () => {
    const { playerId } = await ctx.params;
    const pid = parseId(playerId, "playerId");
    const db = getDb();
    const breakdown = await getPlayerBreakdownForRuleset(
      db,
      HUB_RULESET_VERSION,
      pid,
    );
    if (!breakdown) {
      throw new HttpError(`player ${pid} not found`, "PLAYER_NOT_FOUND", 404);
    }
    return breakdown;
  });
}
