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
import { z } from "zod";

import { globalAdp } from "@/data/stats/adp";
import { handle } from "@/web/api";
import { getDb } from "@/web/db";
import { parseQuery } from "@/web/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Query: ?completedOnly=1 to count only COMPLETE drafts. */
const AdpQuerySchema = z.object({
  completedOnly: z.string().optional().transform((v) => v === "1"),
});

export function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const { completedOnly } = parseQuery(
      new URL(request.url).searchParams,
      AdpQuerySchema,
    );
    const db = getDb();
    return globalAdp(db, { completedDraftsOnly: completedOnly });
  });
}
