/**
 * GET /api/leagues/[leagueId]/lineup?teamId=N
 *   The team's submitted lineups plus the league's scoring periods (with
 *   each period's first kickoff, i.e. its lock time). SET_LINEUP leagues
 *   only. Any league member may view any team's lineups.
 *
 * PUT /api/leagues/[leagueId]/lineup
 *   Submit/replace the signed-in manager's OWN team's lineup for a period.
 *   Body: { teamId, scoringPeriodId, playerIds[11], captainPlayerId,
 *           viceCaptainPlayerId? }
 *   Locks at the period's first kickoff (409-style domain error as 400).
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getScoringPeriods } from "@/data/competition/periods";
import { fantasyTeam, league } from "@/data/db/schema";
import {
  getLineups,
  periodFirstKickoff,
  submitLineup,
} from "@/data/lineup/service";
import { handle, HttpError, parseId } from "@/web/api";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { getMembershipRole } from "@/web/queries";
import { parseBody, parseQuery } from "@/web/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LineupQuerySchema = z.object({
  teamId: z.coerce.number().int().positive(),
});

const SubmitLineupSchema = z.object({
  teamId: z.number().int().positive(),
  scoringPeriodId: z.number().int().positive(),
  playerIds: z.array(z.number().int().positive()).length(11),
  captainPlayerId: z.number().int().positive(),
  viceCaptainPlayerId: z.number().int().positive().nullish(),
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
      LineupQuerySchema,
    );
    const [team] = await db
      .select()
      .from(fantasyTeam)
      .where(and(eq(fantasyTeam.id, teamId), eq(fantasyTeam.leagueId, id)));
    if (!team) {
      throw new HttpError(`team ${teamId} not in league ${id}`, "TEAM_NOT_FOUND", 404);
    }
    const [lg] = await db.select().from(league).where(eq(league.id, id));
    if (!lg) throw new HttpError(`league ${id} not found`, "LEAGUE_NOT_FOUND", 404);

    const periods = await getScoringPeriods(db, lg.competitionId);
    const periodsOut = [];
    for (const p of periods) {
      const firstKickoff = await periodFirstKickoff(db, p);
      periodsOut.push({
        scoringPeriodId: p.id,
        ordinal: p.ordinal,
        label: p.label,
        locksAtUtc: firstKickoff ? firstKickoff.toISOString() : null,
      });
    }
    return {
      format: lg.format,
      periods: periodsOut,
      lineups: await getLineups(db, teamId),
    };
  });
}

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
    const body = await parseBody(request, SubmitLineupSchema);

    // Managers may only set their OWN team's lineup.
    const [team] = await db
      .select()
      .from(fantasyTeam)
      .where(
        and(eq(fantasyTeam.id, body.teamId), eq(fantasyTeam.leagueId, id)),
      );
    if (!team) {
      throw new HttpError(`team ${body.teamId} not in league ${id}`, "TEAM_NOT_FOUND", 404);
    }
    if (team.managerId !== manager.id) {
      throw new HttpError(
        "you can only set your own team's lineup",
        "NOT_YOUR_TEAM",
        403,
      );
    }

    const row = await submitLineup(db, {
      fantasyTeamId: body.teamId,
      scoringPeriodId: body.scoringPeriodId,
      playerIds: body.playerIds,
      captainPlayerId: body.captainPlayerId,
      viceCaptainPlayerId: body.viceCaptainPlayerId ?? null,
    });
    return {
      fantasyTeamId: row.fantasyTeamId,
      scoringPeriodId: row.scoringPeriodId,
      playerIds: row.playerIds,
      captainPlayerId: row.captainPlayerId,
      viceCaptainPlayerId: row.viceCaptainPlayerId,
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}
