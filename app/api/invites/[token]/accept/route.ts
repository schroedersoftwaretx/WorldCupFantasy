/**
 * POST /api/invites/[token]/accept
 *
 * Redeem an invite token: the signed-in manager joins the league. The
 * backend `acceptInvite` enforces every rule (pending, not expired, not
 * full, not already a member) and throws a typed LeagueError, which `handle`
 * maps to a 400.
 */
import { acceptInvite } from "@/data/league/service";
import { handle, HttpError } from "@/web/api";
import type { InviteAcceptedData } from "@/web/api-types";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(
  request: Request,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  return handle(async () => {
    const { manager } = await requireUserForRoute(request);
    const { token } = await ctx.params;
    if (!token) {
      throw new HttpError("missing invite token", "BAD_REQUEST", 400);
    }
    const result = await acceptInvite(getDb(), {
      token,
      managerId: manager.id,
    });
    const data: InviteAcceptedData = { leagueId: result.league.id };
    return data;
  });
}
