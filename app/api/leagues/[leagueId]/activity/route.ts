/**
 * GET /api/leagues/[leagueId]/activity
 *
 * The league's latest activity events (chips played, H2H schedule
 * generated, auto stage recaps), newest first. Member-gated; shown with
 * chat, so it shares the chat feature flag.
 */
import { getFlags } from "@/data/league/feature-flags";
import { listActivity } from "@/data/social/activity";
import { handle, HttpError, parseId } from "@/web/api";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
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
    const flags = await getFlags(db, id);
    if (!flags.chat) {
      throw new HttpError(
        "activity is part of chat, which is not enabled for this league",
        "CHAT_FLAG_DISABLED",
        400,
      );
    }
    return listActivity(db, id);
  });
}
