/**
 * GET /api/stats/records  (public)
 *
 * Tournament records & fun stats: highest-scoring Team of the Stage so far,
 * biggest single-match haul, top nations by goals, and a position scarcity
 * heatmap.
 */
import { memoizeByComputedAt } from "@/data/stats/cache";
import { getRecords } from "@/data/stats/hub";
import { handle } from "@/web/api";
import { getDb } from "@/web/db";
import { HUB_RULESET_VERSION } from "@/web/stats-params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return handle(async () => {
    const db = getDb();
    return memoizeByComputedAt(db, "records", HUB_RULESET_VERSION, () =>
      getRecords(db, { rulesetVersion: HUB_RULESET_VERSION }),
    );
  });
}
