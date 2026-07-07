/**
 * GET /api/cron/ingest-and-score
 *
 * Full automated data pipeline, called by Vercel Cron every 30 minutes.
 * Degrades gracefully based on which env vars are present:
 *
 *   With a provider configured (STATS_PROVIDER or any provider key set):
 *     1. Refresh fixture schedule (SCHEDULED -> LIVE -> FINISHED statuses).
 *     2. Ingest per-player stats for every newly-FINISHED fixture.
 *     3. Recompute fantasy scores from the latest stat_lines.
 *     The provider is chosen by src/data/provider/select.ts (Sportmonks is
 *     preferred when SPORTMONKS_KEY is set — it covers every v2 stat).
 *
 *   Without any provider key (e.g. staging):
 *     3. Recompute fantasy scores only.
 *
 *   With ODDS_API_KEY set:
 *     4. Fetch fresh match odds for upcoming fixtures (cached 3h).
 *     5. Recompute projected points for all SCHEDULED fixtures with odds.
 *
 * This single route replaces both the old ingest-scores cron and the need to
 * run CLI commands after each game. Standings update within 30 minutes of
 * the final whistle once API_FOOTBALL_KEY is set in Vercel.
 *
 * Auth: requires CRON_SECRET as a Bearer token when that env var is set.
 * The operation is fully idempotent -- stale or duplicate calls are safe.
 */
import { resolveProviderName, statsProviderFromEnv } from "@/data/provider/select";
import type { StatsProvider } from "@/data/provider/types";
import { ingestFixtureStats } from "@/data/ingest/fixture-stats";
import { ingestSchedule } from "@/data/ingest/schedule";
import { getUningestedFinishedFixtures } from "@/data/ingest/pending";
import { recomputeAllRulesets } from "@/data/scoring/recompute";
import { DEFAULT_RULESET } from "@/data/scoring/ruleset";
import { generateAllStageRecaps } from "@/data/social/recap";
import { captureAllStandingsSnapshots } from "@/data/standings/snapshot";
import { oddsProviderFromEnv } from "@/data/odds/odds-provider";
import { stageOddsProviderFromEnv } from "@/data/odds/stage-odds-provider";
import { recomputeProjections } from "@/data/projection/recompute-projections";
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
    const env = process.env as NodeJS.ProcessEnv;

    // Build whichever provider is configured (STATS_PROVIDER or auto-detect).
    // If no usable key is present the factory throws -> degrade to recompute-only.
    let provider: StatsProvider | null = null;
    let providerName: string | null = null;
    try {
      provider = statsProviderFromEnv(env);
      providerName = resolveProviderName(env);
    } catch {
      provider = null;
    }

    let scheduleSummary: object | null = null;
    const statsSummaries: Array<{ fixtureId: string; inserted: number; updated: number; skipped: number }> = [];

    if (provider) {
      // Full pipeline: refresh schedule + ingest stats for new fixtures.
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
    // Recompute every league's ruleset (not just the default), so leagues with
    // customised scoring keep populated standings.
    const scoreSummary = await recomputeAllRulesets(db);

    // Step 3b: persist per-stage standings snapshots (rank movement, B2).
    // Internally per-league fault-tolerant; never blocks the pipeline.
    const snapshotSummary = await captureAllStandingsSnapshots(db);
    const recapSummary = await generateAllStageRecaps(db);

    // Steps 4-5: odds + projections (only when ODDS_API_KEY is set).
    let oddsSummary: object | null = null;
    let projectionSummary: object | null = null;
    let stageOddsSummary: object | null = null;
    if (env["ODDS_API_KEY"]) {
      try {
        const oddsProvider = oddsProviderFromEnv(env);
        oddsSummary = await oddsProvider.ingestOdds(db);
        projectionSummary = await recomputeProjections(db, DEFAULT_RULESET);
      } catch (err) {
        // Odds/projection failures are non-fatal: degrade gracefully so stats
        // and scores are not blocked by an odds API outage.
        oddsSummary = { error: err instanceof Error ? err.message : String(err) };
      }
      // Reach-stage futures (chance to make R16/QF/SF/Final/Champion). Cached
      // 12h internally, so this is cheap to call on every 30-min cron tick.
      try {
        stageOddsSummary = await stageOddsProviderFromEnv(env).ingestStageOdds(db);
      } catch (err) {
        stageOddsSummary = { error: err instanceof Error ? err.message : String(err) };
      }
    }

    return {
      mode: provider ? "full" : "recompute-only",
      provider: providerName,
      schedule: scheduleSummary,
      fixturesIngested: statsSummaries.length,
      stats: statsSummaries,
      scores: scoreSummary,
      snapshots: snapshotSummary,
      recaps: recapSummary,
      odds: oddsSummary,
      projections: projectionSummary,
      stageOdds: stageOddsSummary,
    };
  });
}
