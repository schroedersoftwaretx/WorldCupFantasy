/**
 * GET  /api/leagues/[leagueId]/survivor - the pool board (other managers'
 *      unlocked picks masked), your entry, stage lock times, and the
 *      nations available to you.
 * POST /api/leagues/[leagueId]/survivor - join the pool.
 * PUT  /api/leagues/[leagueId]/survivor - submit/replace a pick.
 *      Body: { stage, nationalTeamId }
 *
 * Flag/membership/rules enforced by the survivor service.
 */
import { asc, eq } from "drizzle-orm";
import { z } from "zod";

import { fixture, nationalTeam, stageEnum } from "@/data/db/schema";
import {
  getSurvivorBoard,
  joinSurvivor,
  submitSurvivorPick,
} from "@/data/sidegames/survivor";
import { handle, HttpError, parseId } from "@/web/api";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { getMembershipRole } from "@/web/queries";
import { parseBody } from "@/web/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PickSchema = z.object({
  stage: z.enum(stageEnum.enumValues),
  nationalTeamId: z.number().int().positive(),
});

async function requireMember(
  db: ReturnType<typeof getDb>,
  leagueId: number,
  managerId: number,
): Promise<void> {
  const role = await getMembershipRole(db, leagueId, managerId);
  if (!role) {
    throw new HttpError(`league ${leagueId} not found`, "LEAGUE_NOT_FOUND", 404);
  }
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
    await requireMember(db, id, manager.id);

    const board = await getSurvivorBoard(db, id, manager.id);
    const teams = await db
      .select({ id: nationalTeam.id, name: nationalTeam.name, status: nationalTeam.status })
      .from(nationalTeam)
      .orderBy(asc(nationalTeam.name));
    const kicks = await db
      .select({ stage: fixture.stage, kickoffUtc: fixture.kickoffUtc })
      .from(fixture);
    const firstByStage: Record<string, string> = {};
    for (const k of kicks) {
      const cur = firstByStage[k.stage];
      const iso = k.kickoffUtc.toISOString();
      if (!cur || iso < cur) firstByStage[k.stage] = iso;
    }
    return {
      viewerManagerId: manager.id,
      board,
      teams,
      stageLocksAtUtc: firstByStage,
    };
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
    await requireMember(db, id, manager.id);
    return joinSurvivor(db, { leagueId: id, managerId: manager.id });
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
    await requireMember(db, id, manager.id);
    const body = await parseBody(request, PickSchema);
    return submitSurvivorPick(db, {
      leagueId: id,
      managerId: manager.id,
      stage: body.stage,
      nationalTeamId: body.nationalTeamId,
    });
  });
}
