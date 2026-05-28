/**
 * POST /api/leagues/[leagueId]/draft/pick   body: { playerId }
 *
 * The signed-in manager drafts a player. The backend `makePick` enforces
 * that the manager's team is on the clock and that the pick keeps a legal
 * roster, throwing a typed DraftError / RosterError -> 400.
 */
import { makePick } from "@/data/draft/service";
import { handle, HttpError, parseId } from "@/web/api";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { findDraftRoom, getManagerTeam } from "@/web/draft-view";
import { getMembershipRole } from "@/web/queries";

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
    const team = await getManagerTeam(db, id, manager.id);
    if (!team) {
      throw new HttpError("you have no team in this league", "NO_TEAM", 404);
    }
    const room = await findDraftRoom(db, id);
    if (!room) {
      throw new HttpError("no draft room for this league", "DRAFT_NOT_FOUND", 404);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new HttpError("request body must be JSON", "BAD_REQUEST", 400);
    }
    const { playerId } = body as { playerId?: unknown };
    if (typeof playerId !== "number" || !Number.isInteger(playerId)) {
      throw new HttpError("playerId (a number) is required", "BAD_REQUEST", 400);
    }

    const result = await makePick(db, {
      draftRoomId: room.id,
      fantasyTeamId: team.id,
      playerId,
    });
    return {
      pickNumber: result.pickNumber,
      round: result.round,
      autopicked: result.autopicked,
    };
  });
}
