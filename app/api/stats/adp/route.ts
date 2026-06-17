/**
 * GET /api/stats/adp  (public)
 *
 * Average Draft Position & draft analytics across every league's draft: mean
 * pick number, earliest/latest, take-rate, and reach/steal vs pre-tournament
 * draft_rank. Aggregate-only — never reveals which draft made which pick.
 *
 * Query params:
 *   completedOnly=1  only count COMPLETE drafts (default: any started draft).
 */
import { globalAdp } from "@/data/stats/adp";
import { handle } from "@/web/api";
import { getDb } from "@/web/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const completedOnly =
      new URL(request.url).searchParams.get("completedOnly") === "1";
    const db = getDb();
    return globalAdp(db, { completedDraftsOnly: completedOnly });
  });
}
