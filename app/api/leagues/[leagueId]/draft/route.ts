/**
 * GET  /api/leagues/[leagueId]/draft  - the draft-room state (the poll target).
 * POST /api/leagues/[leagueId]/draft  - create the draft room (owner only).
 *
 * Both are auth- and membership-gated.
 */
import { createDraftRoom } from "@/data/draft/service";
import { handle, HttpError, parseId } from "@/web/api";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { getDraftRoomView } from "@/web/draft-view";
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
    return getDraftRoomView(db, id, manager.id);
  });
}

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
        "only the league owner can create the draft",
        "FORBIDDEN",
        403,
      );
    }

    // The body (an optional pick timer) may be absent entirely.
    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const { pickTimerHours } = body as { pickTimerHours?: unknown };
    const input: { leagueId: number; pickTimerHours?: number } = {
      leagueId: id,
    };
    if (typeof pickTimerHours === "number") {
      input.pickTimerHours = pickTimerHours;
    }

    const room = await createDraftRoom(db, input);
    return { draftRoomId: room.id };
  });
}
