/**
 * GET /api/leagues/[leagueId]/roster?teamId=N
 *
 * Returns the RosterViewData for a team in this league: each rostered player
 * annotated with their raw per-period points and best-ball XI selection.
 *
 * Query params:
 *   teamId (required) - the fantasy_team.id to inspect
 *
 * Auth-gated and membership-gated: only league members can view any team's
 * roster. The teamId must belong to the league.
 */
import { z } from "zod";

import { handle, HttpError, parseId } from "@/web/api";
import type { RosterViewData } from "@/web/api-types";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { getMembershipRole } from "@/web/queries";
import { getRosterScores } from "@/web/standings-view";
import { parseQuery } from "@/web/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Query: required positive-integer teamId. */
const RosterQuerySchema = z.object({
  teamId: z.coerce.number().int().positive(),
});

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

    const { teamId } = parseQuery(
      new URL(request.url).searchParams,
      RosterQuerySchema,
    );

    const data: RosterViewData = await getRosterScores(db, id, teamId);
    return data;
  });
}
