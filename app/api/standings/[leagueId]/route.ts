/**
 * GET /api/standings/[leagueId]
 *
 * Live standings for a league: cumulative best-ball totals and the section
 * 5.3 tie-breaker ladder, recomputed on every request. Auth-gated and
 * membership-gated (W3): a non-member gets a 404.
 */
import { eq } from "drizzle-orm";

import { league } from "@/data/db/schema";
import { computeStandings } from "@/data/standings/standings";
import { handle, HttpError, parseId } from "@/web/api";
import type { StandingsData } from "@/web/api-types";
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
    const [lg] = await db.select().from(league).where(eq(league.id, id));
    if (!lg) {
      throw new HttpError(`league ${id} not found`, "LEAGUE_NOT_FOUND", 404);
    }

    const standings = await computeStandings(db, id);
    const data: StandingsData = {
      leagueId: id,
      leagueName: lg.name,
      standings,
    };
    return data;
  });
}
