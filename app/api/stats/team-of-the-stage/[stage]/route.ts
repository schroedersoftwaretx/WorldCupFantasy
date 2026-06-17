/**
 * GET /api/stats/team-of-the-stage/[stage]  (public)
 *
 * The single best-scoring legal XI from the GLOBAL player pool for one scoring
 * period, scored against the canonical Hub ruleset. Memoized on the latest
 * score_entry.computedAt so a recompute transparently refreshes it.
 */
import { memoizeByComputedAt } from "@/data/stats/cache";
import { teamOfTheStage } from "@/data/stats/team-of-the-stage";
import { handle } from "@/web/api";
import { getDb } from "@/web/db";
import { HUB_RULESET_VERSION, parseStage } from "@/web/stats-params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(
  _request: Request,
  ctx: { params: Promise<{ stage: string }> },
): Promise<Response> {
  return handle(async () => {
    const { stage } = await ctx.params;
    const s = parseStage(stage);
    const db = getDb();
    return memoizeByComputedAt(db, `tos:${s}`, HUB_RULESET_VERSION, () =>
      teamOfTheStage(db, { rulesetVersion: HUB_RULESET_VERSION, stage: s }),
    );
  });
}
