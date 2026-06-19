/**
 * GET /api/leagues/[leagueId]/awards  (membership-gated)
 *
 * The per-league Trophy Room: every DERIVED tournament award (Phase 7.1),
 * each a ranked leaderboard of this league's fantasy teams. Awards are scored
 * against the league's OWN ruleset version (league.scoringRuleset.version) so
 * the points match what the league sees on its standings/roster surfaces.
 *
 * Only league members may read it; the league must exist.
 */
import { eq } from "drizzle-orm";

import { computeTrophyRoom } from "@/data/awards/registry";
import { league } from "@/data/db/schema";
import type { ScoringRuleset } from "@/data/scoring/ruleset";
import { handle, HttpError, parseId } from "@/web/api";
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
    const rulesetVersion = (lg.scoringRuleset as ScoringRuleset).version;

    return computeTrophyRoom(db, { leagueId: id, rulesetVersion });
  });
}
