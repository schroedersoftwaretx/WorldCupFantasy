/**
 * GET /api/leagues/[leagueId]/players/[playerId]/breakdown
 *
 * Membership-gated. Returns the per-rule score breakdown for one player
 * across all their scored fixtures, under the league's active ruleset.
 * Used by the standings XI overlay to explain how a player's points add up.
 */
import { getPlayerBreakdown } from "@/data/standings/player-breakdown";
import { handle, HttpError, parseId } from "@/web/api";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { getMembershipRole } from "@/web/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(
  request: Request,
  ctx: { params: Promise<{ leagueId: string; playerId: string }> },
): Promise<Response> {
  return handle(async () => {
    const { manager } = await requireUserForRoute(request);
    const { leagueId, playerId } = await ctx.params;
    const lid = parseId(leagueId, "leagueId");
    const pid = parseId(playerId, "playerId");
    const db = getDb();

    const role = await getMembershipRole(db, lid, manager.id);
    if (!role) {
      throw new HttpError(`league ${lid} not found`, "LEAGUE_NOT_FOUND", 404);
    }

    const breakdown = await getPlayerBreakdown(db, lid, pid);
    if (!breakdown) {
      throw new HttpError(`player ${pid} not found`, "PLAYER_NOT_FOUND", 404);
    }
    return breakdown;
  });
}
