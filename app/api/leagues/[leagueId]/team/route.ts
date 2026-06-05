/**
 * PATCH /api/leagues/[leagueId]/team
 *
 * Rename the signed-in manager's fantasy team within this league.
 * Body: { name: string }
 */
import { and, eq } from "drizzle-orm";

import { handle, HttpError, parseId } from "@/web/api";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { getMembershipRole } from "@/web/queries";
import { fantasyTeam } from "@/data/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function PATCH(
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

    const body = (await request.json()) as { name?: unknown };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      throw new HttpError("name must not be empty", "INVALID_TEAM_NAME", 400);
    }
    if (name.length > 50) {
      throw new HttpError("name must be 50 characters or fewer", "INVALID_TEAM_NAME", 400);
    }

    const [updated] = await db
      .update(fantasyTeam)
      .set({ name })
      .where(
        and(
          eq(fantasyTeam.leagueId, id),
          eq(fantasyTeam.managerId, manager.id),
        ),
      )
      .returning({ name: fantasyTeam.name });

    if (!updated) {
      throw new HttpError("team not found", "TEAM_NOT_FOUND", 404);
    }

    return { teamName: updated.name };
  });
}
