/**
 * GET /api/cron/ingest-and-score
 *
 * Full automated data pipeline, called by Vercel Cron every 30 minutes.
 * Degrades gracefully based on which env vars are present:
 *
 *   With API_FOOTBALL_KEY set (production):
 *     1. Refresh fixture schedule (SCHEDULED -> LIVE -> FINISHED statuses).
 *     2. Ingest per-player stats for every newly-FINISHED fixture.
 *     3. Recompute fantasy scores from the latest stat_lines.
 *
 *   Without API_FOOTBALL_KEY (e.g. staging without a provider key):
 *     3. Recompute fantasy scores only (same as the old ingest-scores cron).
 *
 * This single route replaces both the old ingest-scores cron and the need to
 * run CLI commands after each game. Standings update within 30 minutes of
 * the final whistle once API_FOOTBALL_KEY is set in Vercel.
 *
 * Auth: requires CRON_SECRET as a Bearer token when that env var is set.
 * The operation is fully idempotent -- stale or duplicate calls are safe.
 */
import { apiFootballFromEnv } from "@/data/provider/api-football";
import { ingestFixtureStats } from "@/data/ingest/fixture-stats";
import { ingestSchedule } from "@/data/ingest/schedule";
import { getUningestedFinishedFixtures } from "@/data/ingest/pending";
import { recomputeAll } from "@/data/scoring/recompute";
import { DEFAULT_RULESET } from "@/data/scoring/ruleset";
import { handle, HttpError } from "@/web/api";
import { getDb } from "@/web/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Allow up to 5 minutes: ingesting a full matchday (8 games) at the
// provider rate limit of ~10 req/min takes roughly 60 seconds.
export const maxDuration = 300;

export function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const secret = process.env["CRON_SECRET"];
    if (secret) {
      if (request.headers.get("authorization") !== `Bearer ${secret}`) {
        throw new HttpError("unauthorized", "UNAUTHORIZED", 401);
      }
    }

    const db = getDb();
    const apiKey = process.env["API_FOOTBALL_KEY"];

    let scheduleSummary: object | null = null;
    const statsSummaries: Array<{ fixtureId: string; inserted: number; updated: number; skipped: number }> = [];

    if (apiKey) {
      // Full pipeline: refresh schedule + ingest stats for new fixtures.
      const provider = apiFootballFromEnv(process.env as NodeJS.ProcessEnv);

      // Step 1: refresh fixture statuses.
      scheduleSummary = await ingestSchedule(db, provider);

      // Step 2: ingest stats for newly-finished fixtures.
      const pending = await getUningestedFinishedFixtures(db);
      for (const fx of pending) {
        const s = await ingestFixtureStats(db, provider, fx.sourceFixtureId);
        statsSummaries.push({ fixtureId: fx.sourceFixtureId, ...s });
      }
    }

    // Step 3: always recompute scores from the latest stat_lines.
    const scoreSummary = await recomputeAll(db, DEFAULT_RULESET);

    return {
      mode: apiKey ? "full" : "recompute-only",
      schedule: scheduleSummary,
      fixturesIngested: statsSummaries.length,
      stats: statsSummaries,
      scores: scoreSummary,
    };
  });
}
