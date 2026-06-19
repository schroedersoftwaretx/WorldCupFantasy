/**
 * GET /api/stats/awards  (public)
 *
 * The global Stats Hub awards: tournament-wide, player-attributed awards
 * (Golden Boot, Playmaker, Golden Glove, biggest single-match haul) scored
 * against HUB_RULESET_VERSION. Not league-specific and not login-gated, like
 * the rest of the Stats Hub.
 */
import { computeGlobalAwards } from "@/data/awards/registry";
import { memoizeByComputedAt } from "@/data/stats/cache";
import { handle } from "@/web/api";
import { getDb } from "@/web/db";
import { HUB_RULESET_VERSION } from "@/web/stats-params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return handle(async () => {
    const db = getDb();
    return memoizeByComputedAt(db, "awards", HUB_RULESET_VERSION, () =>
      computeGlobalAwards(db, { rulesetVersion: HUB_RULESET_VERSION }),
    );
  });
}
