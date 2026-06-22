/**
 * POST /api/admin/stats
 *
 * Admin-only manual stat-line editor. Body:
 *   {
 *     "fixtureId": 12,          // internal fixture id
 *     "playerId": 1001,         // internal player id
 *     "edit": { "saves": 3, "crosses": 5, ... },
 *     "note": "saves reassigned after 70' GK substitution"
 *   }
 *
 * Writes the edit (locking the row against provider re-ingest), then
 * recomputes score_entry for that fixture under every distinct ruleset in use
 * (the canonical DEFAULT_RULESET plus any custom league rulesets) so standings
 * reflect the change immediately.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";

import { fixture, league } from "@/data/db/schema";
import { recomputeForFixture } from "@/data/scoring/recompute";
import { DEFAULT_RULESET, type ScoringRuleset } from "@/data/scoring/ruleset";
import { applyManualStatEdit, sanitizeStatEdit } from "@/data/stats/manual-edit";
import { handle, HttpError } from "@/web/api";
import { requireAdminForRoute } from "@/web/auth/admin";
import { getDb } from "@/web/db";
import { parseBody } from "@/web/validate";
import { enforceRateLimit, LIMITS } from "@/web/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST body. ids are coerced from string/number to a positive int (matching
 * the old `parseId(String(...))`). The `edit` map's field-level validation
 * stays in `sanitizeStatEdit` (INVALID_EDIT). A non-string `note` is tolerated
 * and treated as absent, as before.
 */
const StatEditSchema = z.object({
  fixtureId: z.coerce.number().int().positive(),
  playerId: z.coerce.number().int().positive(),
  edit: z.record(z.string(), z.unknown()),
  note: z.unknown().optional().transform((v) => (typeof v === "string" ? v : null)),
});

export function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const { manager } = await requireAdminForRoute(request);
    await enforceRateLimit(request, {
      name: "admin-stat-edit",
      ...LIMITS.adminStatEdit,
      managerId: manager.id,
    });

    const body = await parseBody(request, StatEditSchema);
    const fixtureId = body.fixtureId;
    const playerId = body.playerId;
    const note = body.note ?? null;

    let edit;
    try {
      edit = sanitizeStatEdit(body.edit);
    } catch (e) {
      throw new HttpError(e instanceof Error ? e.message : "invalid edit", "INVALID_EDIT", 400);
    }
    if (Object.keys(edit).length === 0) {
      throw new HttpError("`edit` contained no editable fields", "INVALID_EDIT", 400);
    }

    const db = getDb();

    // Resolve the provider fixture id required by recomputeForFixture.
    const [fxRow] = await db
      .select({ sourceFixtureId: fixture.sourceFixtureId })
      .from(fixture)
      .where(eq(fixture.id, fixtureId));
    if (!fxRow) {
      throw new HttpError(`fixture ${fixtureId} not found`, "FIXTURE_NOT_FOUND", 404);
    }

    const result = await applyManualStatEdit(db, { playerId, fixtureId, edit, note });

    // Recompute the fixture under every distinct ruleset in use.
    const rulesets: ScoringRuleset[] = [DEFAULT_RULESET];
    const leagues = await db.select({ scoringRuleset: league.scoringRuleset }).from(league);
    const seen = new Set<string>([DEFAULT_RULESET.version]);
    for (const lg of leagues) {
      const rs = lg.scoringRuleset as ScoringRuleset;
      if (rs && rs.version && !seen.has(rs.version)) {
        seen.add(rs.version);
        rulesets.push(rs);
      }
    }

    const recomputed: Array<{
      version: string;
      inserted: number;
      updated: number;
      skipped: number;
    }> = [];
    for (const rs of rulesets) {
      const s = await recomputeForFixture(db, rs, fxRow.sourceFixtureId);
      recomputed.push({ version: rs.version, ...s });
    }

    return { action: result.action, recomputed };
  });
}
