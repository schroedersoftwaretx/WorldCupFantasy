/**
 * POST /api/leagues/[leagueId]/invites
 *
 * Generate an open invite link for a league. Owner-only. The returned token
 * forms the join URL /invite/[token].
 */
import { inviteManager } from "@/data/league/service";
import { handle, HttpError, parseId } from "@/web/api";
import type { InviteCreatedData } from "@/web/api-types";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
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
    if (role !== "OWNER") {
      throw new HttpError(
        "only the league owner can create invites",
        "FORBIDDEN",
        403,
      );
    }

    const invite = await inviteManager(db, { leagueId: id });
    const data: InviteCreatedData = {
      token: invite.token,
      path: `/invite/${invite.token}`,
    };
    return data;
  });
}
