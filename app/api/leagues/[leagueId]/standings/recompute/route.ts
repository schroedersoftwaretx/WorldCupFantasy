/**
 * POST /api/leagues/[leagueId]/standings/recompute
 *
 * Owner-only manual score recomputation. Runs recomputeAll for the league's
 * scoring ruleset so the standings page reflects the latest stat_line rows
 * without waiting for the next cron cycle.
 *
 * Returns a RecomputeResult summary of rows inserted / updated / skipped.
 */
import { eq } from "drizzle-orm";

import { league } from "@/data/db/schema";
import { recomputeAll } from "@/data/scoring/recompute";
import type { ScoringRuleset } from "@/data/scoring/ruleset";
import { handle, HttpError, parseId } from "@/web/api";
import type { RecomputeResult } from "@/web/api-types";
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
        "only the league owner can recompute scores",
        "FORBIDDEN",
        403,
      );
    }

    const [lg] = await db.select().from(league).where(eq(league.id, id));
    if (!lg) {
      throw new HttpError(`league ${id} not found`, "LEAGUE_NOT_FOUND", 404);
    }

    const ruleset = lg.scoringRuleset as ScoringRuleset;
    const summary = await recomputeAll(db, ruleset);

    const result: RecomputeResult = {
      inserted: summary.inserted,
      updated: summary.updated,
      skipped: summary.skipped,
    };
    return result;
  });
}
