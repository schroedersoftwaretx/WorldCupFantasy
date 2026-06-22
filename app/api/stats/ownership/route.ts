/**
 * GET /api/stats/ownership  (public)
 *
 * Cross-league ownership: for every owned player, how many distinct fantasy
 * teams (across all leagues) roster them and what fraction of teams that is.
 * Aggregate-only — never reveals which specific team owns whom.
 *
 * Query params:
 *   includeUnfinished=1  count leagues still in SETUP/DRAFTING too (default:
 *                        only finished-draft leagues, for a cleaner denominator).
 */
import { z } from "zod";

import { globalOwnership } from "@/data/stats/ownership";
import { handle } from "@/web/api";
import { getDb } from "@/web/db";
import { parseQuery } from "@/web/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Query: ?includeUnfinished=1 to count SETUP/DRAFTING leagues too. */
const OwnershipQuerySchema = z.object({
  includeUnfinished: z.string().optional().transform((v) => v === "1"),
});

export function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const { includeUnfinished } = parseQuery(
      new URL(request.url).searchParams,
      OwnershipQuerySchema,
    );
    const db = getDb();
    return globalOwnership(db, { finishedDraftsOnly: !includeUnfinished });
  });
}
