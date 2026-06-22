/**
 * POST /api/leagues/[leagueId]/draft/tick
 *
 * The manual "process timeouts" button: autopick any pick in this league's
 * draft whose timer has lapsed. Idempotent - a no-op when nothing is
 * expired. Any league member may trigger it (it only ever acts on already-
 * expired picks, so it cannot skip a live turn).
 */
import { processExpiredPicks } from "@/data/draft/service";
import { handle, HttpError, parseId } from "@/web/api";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { findDraftRoom } from "@/web/draft-view";
import { getNotifier } from "@/web/notifier";
import { getMembershipRole } from "@/web/queries";
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
    const room = await findDraftRoom(db, id);
    if (!room) {
      throw new HttpError("no draft room for this league", "DRAFT_NOT_FOUND", 404);
    }
    await enforceRateLimit(request, {
      name: "draft-tick",
      ...LIMITS.draftTick,
      managerId: manager.id,
    });
    const notifier = getNotifier();
    const result = await processExpiredPicks(db, {
      draftRoomId: room.id,
      ...(notifier ? { notifier } : {}),
    });
    return result;
  });
}
