/**
 * PATCH /api/leagues/[leagueId]/team
 *
 * Rename the signed-in manager's fantasy team within this league.
 * Body: { name: string }
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { handle, HttpError, parseId } from "@/web/api";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { getMembershipRole } from "@/web/queries";
import { parseBody } from "@/web/validate";
import { fantasyTeam } from "@/data/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Rename body: a 1-50 char team name, trimmed before length checks. */
const RenameTeamSchema = z.object({
  name: z
    .string()
    .transform((v) => v.trim())
    .pipe(
      z
        .string()
        .min(1, "name must not be empty")
        .max(50, "name must be 50 characters or fewer"),
    ),
});

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

    const { name } = await parseBody(request, RenameTeamSchema);

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
