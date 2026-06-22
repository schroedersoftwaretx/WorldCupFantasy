/**
 * POST /api/leagues/[leagueId]/draft/start
 *
 * Start the draft: freeze a random snake order, put pick 1 on the clock,
 * move the league to DRAFTING. Owner only. The backend `startDraft` requires
 * at least 2 teams and throws a typed DraftError otherwise.
 */
import { startDraft } from "@/data/draft/service";
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
    if (role !== "OWNER") {
      throw new HttpError(
        "only the league owner can start the draft",
        "FORBIDDEN",
        403,
      );
    }
    await enforceRateLimit(request, {
      name: "draft-start",
      ...LIMITS.draftStart,
      managerId: manager.id,
    });
    const room = await findDraftRoom(db, id);
    if (!room) {
      throw new HttpError(
        "no draft room - create it first",
        "DRAFT_NOT_FOUND",
        404,
      );
    }
    const notifier = getNotifier();
    await startDraft(db, {
      draftRoomId: room.id,
      ...(notifier ? { notifier } : {}),
    });
    return { started: true };
  });
}
