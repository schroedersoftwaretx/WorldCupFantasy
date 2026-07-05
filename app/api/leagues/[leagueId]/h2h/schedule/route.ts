/**
 * POST /api/leagues/[leagueId]/h2h/schedule
 *
 * Generate (or regenerate) the league's head-to-head matchup schedule -
 * a deterministic round-robin over the competition's scoring periods.
 * Owner-only. Regeneration is blocked once any scheduled period has
 * finalized (H2H_SCHEDULE_LOCKED). The flag gate lives in the service.
 */
import { generateSchedule } from "@/data/h2h/schedule";
import { handle, HttpError, parseId } from "@/web/api";
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
        "only the league owner can generate the schedule",
        "OWNER_ONLY",
        403,
      );
    }
    return generateSchedule(db, id);
  });
}
