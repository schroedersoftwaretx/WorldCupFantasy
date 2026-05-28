/**
 * GET /api/leagues/[leagueId]/draft/board
 *
 * The available-player board: every undrafted player, each flagged with
 * whether it would be a legal addition to the viewer's roster. Fetched on
 * load and whenever a pick is made - it is heavier than the state poll, so
 * it is a separate endpoint.
 */
import { handle, HttpError, parseId } from "@/web/api";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { getDraftBoard } from "@/web/draft-view";
import { getMembershipRole } from "@/web/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(
  request: Request,
  ctx: { params: Promise<{ leagueId: string }> },
): Promise<Response> {
  return handle(async () => {
    const { manager } = await requireUserForRoute(request);
    const { leagueId } = await ctx.params;
    const id = parseId(leagueId, "leagueId");
    const db = getDb();
    const role = await getMembershipRole(db, id, manager.id);
    if (!role) {
      throw new HttpError(`league ${id} not found`, "LEAGUE_NOT_FOUND", 404);
    }
    return getDraftBoard(db, id, manager.id);
  });
}
