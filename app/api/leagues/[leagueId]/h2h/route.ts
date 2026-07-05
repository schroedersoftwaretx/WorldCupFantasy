/**
 * GET /api/leagues/[leagueId]/h2h
 *
 * The league's head-to-head view: every matchup with current points and
 * (once its period finalizes) the W/D/L outcome, the ranked H2H table, and
 * pairwise rivalry records. Results are derived from the same period
 * totals as the standings page - nothing is stored but the schedule.
 *
 * Member-gated, and 400 H2H_FLAG_DISABLED unless the league's
 * head_to_head feature flag is on. The flag's config (e.g.
 * { primaryStandings: true }) is echoed for the UI.
 */
import { computeH2h } from "@/data/h2h/results";
import { getSchedule } from "@/data/h2h/schedule";
import { getFlagStates } from "@/data/league/feature-flags";
import { handle, HttpError } from "@/web/api";
import { parseId } from "@/web/api";
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
    const flags = await getFlagStates(db, id);
    const h2h = flags.head_to_head;
    if (!h2h.enabled) {
      throw new HttpError(
        "head-to-head is not enabled for this league",
        "H2H_FLAG_DISABLED",
        400,
      );
    }

    const view = await computeH2h(db, id);
    const scheduled = (await getSchedule(db, id)).length > 0;
    return { config: h2h.config ?? null, scheduled, ...view };
  });
}
