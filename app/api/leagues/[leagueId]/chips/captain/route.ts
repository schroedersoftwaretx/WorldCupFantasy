/**
 * PUT /api/leagues/[leagueId]/chips/captain
 *
 * Nominate (or change) the signed-in manager's OWN team's captain for a
 * scoring period - the best-ball captain layer (x2; x3 under
 * TRIPLE_CAPTAIN). SET_LINEUP leagues set their captain on the lineup and
 * get CAPTAIN_VIA_LINEUP here. Locks at the period's first kickoff.
 * Body: { teamId, scoringPeriodId, playerId }
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { setPeriodCaptain } from "@/data/chips/service";
import { fantasyTeam } from "@/data/db/schema";
import { handle, HttpError, parseId } from "@/web/api";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { getMembershipRole } from "@/web/queries";
import { parseBody } from "@/web/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SetCaptainSchema = z.object({
  teamId: z.number().int().positive(),
  scoringPeriodId: z.number().int().positive(),
  playerId: z.number().int().positive(),
});

export function PUT(
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
    const body = await parseBody(request, SetCaptainSchema);
    const [team] = await db
      .select()
      .from(fantasyTeam)
      .where(and(eq(fantasyTeam.id, body.teamId), eq(fantasyTeam.leagueId, id)));
    if (!team) {
      throw new HttpError(`team ${body.teamId} not in league ${id}`, "TEAM_NOT_FOUND", 404);
    }
    if (team.managerId !== manager.id) {
      throw new HttpError("you can only set your own team's captain", "NOT_YOUR_TEAM", 403);
    }
    return setPeriodCaptain(db, {
      fantasyTeamId: body.teamId,
      scoringPeriodId: body.scoringPeriodId,
      playerId: body.playerId,
    });
  });
}
