/**
 * GET /api/stats/leaderboards[?stage=GROUP_1]  (public)
 *
 * Tournament leaderboards: top scorers overall + per position, raw-stat
 * leaders, form, and best single-match hauls. Optional `stage` query param
 * scopes every list to one period.
 */
import { memoizeByComputedAt } from "@/data/stats/cache";
import { getLeaderboards } from "@/data/stats/hub";
import { handle } from "@/web/api";
import { getDb } from "@/web/db";
import { HUB_RULESET_VERSION, parseStage } from "@/web/stats-params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const raw = new URL(request.url).searchParams.get("stage");
    const stage = raw ? parseStage(raw) : undefined;
    const db = getDb();
    return memoizeByComputedAt(
      db,
      `lb:${stage ?? "all"}`,
      HUB_RULESET_VERSION,
      () =>
        getLeaderboards(db, {
          rulesetVersion: HUB_RULESET_VERSION,
          ...(stage !== undefined ? { stage } : {}),
        }),
    );
  });
}
