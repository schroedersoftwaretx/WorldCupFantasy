/**
 * POST /api/leagues/[leagueId]/draft/force-pick
 *
 * Owner-only. Immediately autopicks for the team currently on the clock,
 * bypassing the timer. Used when a manager is taking too long.
 */
import { forceCurrentAutopick } from "@/data/draft/service";
import { handle, HttpError, parseId } from "@/web/api";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { getMembershipRole } from "@/web/queries";
import { getDraftRoomRow } from "@/web/draft-view";
import { getNotifier } from "@/web/notifier";
import { enforceRateLimit, LIMITS } from "@/web/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(
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
    if (role !== "OWNER") {
      throw new HttpError(
        "only the league owner can force a pick",
        "FORBIDDEN",
        403,
      );
    }
    await enforceRateLimit(request, {
      name: "draft-force-pick",
      ...LIMITS.draftForcePick,
      managerId: manager.id,
    });

    const room = await getDraftRoomRow(db, id);
    if (!room) {
      throw new HttpError("no draft room for this league", "NOT_FOUND", 404);
    }
    if (room.status !== "IN_PROGRESS") {
      throw new HttpError("draft is not in progress", "DRAFT_NOT_IN_PROGRESS", 400);
    }

    const result = await forceCurrentAutopick(db, room.id, new Date(), getNotifier());
    return { pick: result.pick };
  });
}
