/**
 * PUT /api/leagues/[leagueId]/scoring
 *
 * Owner-only custom scoring. Validates the submitted rule values, re-versions
 * the ruleset (content hash via buildRuleset), writes it onto the league, then
 * immediately recomputes every score_entry for the new ruleset version so the
 * standings/awards/breakdown surfaces reflect the change end to end — no
 * separate repoint or cron wait needed.
 *
 * Returns the new ruleset version and a recompute summary.
 */
import { setLeagueScoringRuleset } from "@/data/league/service";
import { recomputeAll } from "@/data/scoring/recompute";
import {
  RulesetValidationError,
  sanitizeRulesetInput,
} from "@/data/scoring/ruleset";
import { captureStandingsSnapshots } from "@/data/standings/snapshot";
import { handle, HttpError, parseId } from "@/web/api";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { getMembershipRole } from "@/web/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function PUT(
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
        "only the league owner can edit scoring",
        "FORBIDDEN",
        403,
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new HttpError("request body must be JSON", "BAD_REQUEST", 400);
    }

    let values: ReturnType<typeof sanitizeRulesetInput>;
    try {
      values = sanitizeRulesetInput(body);
    } catch (e) {
      if (e instanceof RulesetValidationError) {
        throw new HttpError(e.message, "INVALID_RULESET", 400);
      }
      throw e;
    }

    const ruleset = await setLeagueScoringRuleset(db, id, values);
    const summary = await recomputeAll(db, ruleset);

    // Refresh per-stage standings snapshots so rank-movement arrows track the
    // rescore. Non-fatal if the table isn't migrated yet.
    try {
      await captureStandingsSnapshots(db, id);
    } catch {
      // ignore — snapshots are a derived nicety, never block the rescore
    }

    return {
      version: ruleset.version,
      inserted: summary.inserted,
      updated: summary.updated,
      skipped: summary.skipped,
    };
  });
}
