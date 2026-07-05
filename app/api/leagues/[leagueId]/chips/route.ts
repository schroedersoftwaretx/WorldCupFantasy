/**
 * GET  /api/leagues/[leagueId]/chips?teamId=N - a team's chip state:
 *      chips played, chips remaining, and period captains. Member-gated
 *      (selections are visible to the league; they lock at kickoff anyway).
 * POST /api/leagues/[leagueId]/chips - spend a chip on a period for the
 *      signed-in manager's OWN team.
 *      Body: { teamId, scoringPeriodId, chip }
 *
 * The chips feature flag and all game rules (one use per chip, no stacking,
 * kickoff lock) are enforced in the chips service.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getChipState, playChip } from "@/data/chips/service";
import { chipTypeEnum, fantasyTeam } from "@/data/db/schema";
import { handle, HttpError, parseId } from "@/web/api";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { getMembershipRole } from "@/web/queries";
import { parseBody, parseQuery } from "@/web/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ChipsQuerySchema = z.object({
  teamId: z.coerce.number().int().positive(),
});

const PlayChipSchema = z.object({
  teamId: z.number().int().positive(),
  scoringPeriodId: z.number().int().positive(),
  chip: z.enum(chipTypeEnum.enumValues),
});

async function requireTeamInLeague(
  db: ReturnType<typeof getDb>,
  leagueId: number,
  teamId: number,
) {
  const [team] = await db
    .select()
    .from(fantasyTeam)
    .where(and(eq(fantasyTeam.id, teamId), eq(fantasyTeam.leagueId, leagueId)));
  if (!team) {
    throw new HttpError(`team ${teamId} not in league ${leagueId}`, "TEAM_NOT_FOUND", 404);
  }
  return team;
}

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
    const { teamId } = parseQuery(new URL(request.url).searchParams, ChipsQuerySchema);
    await requireTeamInLeague(db, id, teamId);
    return getChipState(db, teamId);
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
    const body = await parseBody(request, PlayChipSchema);
    const team = await requireTeamInLeague(db, id, body.teamId);
    if (team.managerId !== manager.id) {
      throw new HttpError("you can only play your own team's chips", "NOT_YOUR_TEAM", 403);
    }
    return playChip(db, {
      fantasyTeamId: body.teamId,
      scoringPeriodId: body.scoringPeriodId,
      chip: body.chip,
    });
  });
}
