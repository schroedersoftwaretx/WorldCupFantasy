/**
 * GET /api/cron/ingest-scores
 *
 * Scheduled score recomputation. Runs recomputeAll for every league's scoring
 * ruleset so standings reflect the latest ingested stat_line rows.
 *
 * Called by Vercel Cron (see vercel.json). When CRON_SECRET is set, the
 * caller must present it as a Bearer token; Vercel injects this automatically.
 * When unset the route is open (local dev). The operation is idempotent, so a
 * duplicate call is harmless.
 *
 * Note: this recomputes scores but does NOT ingest new stat_lines from the
 * provider. Raw stat ingestion stays on the CLI (`ingest:fixture-stats`), which
 * requires the API-Football credentials. After a CLI ingest run, this cron job
 * (or the manual recompute button on the standings page) makes the new scores
 * visible in the web app.
 */
import { eq } from "drizzle-orm";

import { league } from "@/data/db/schema";
import { recomputeAll } from "@/data/scoring/recompute";
import type { ScoringRuleset } from "@/data/scoring/ruleset";
import { handle, HttpError } from "@/web/api";
import { getDb } from "@/web/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const secret = process.env["CRON_SECRET"];
    if (secret) {
      if (request.headers.get("authorization") !== `Bearer ${secret}`) {
        throw new HttpError("unauthorized", "UNAUTHORIZED", 401);
      }
    }

    const db = getDb();
    const leagues = await db.select().from(league);

    // Deduplicate rulesets so we only recompute once per unique ruleset version
    // even if multiple leagues share the same ruleset.
    const seenVersions = new Set<string>();
    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    for (const lg of leagues) {
      const ruleset = lg.scoringRuleset as ScoringRuleset;
      if (seenVersions.has(ruleset.version)) continue;
      seenVersions.add(ruleset.version);

      const summary = await recomputeAll(db, ruleset);
      inserted += summary.inserted;
      updated += summary.updated;
      skipped += summary.skipped;
    }

    return {
      leaguesProcessed: leagues.length,
      rulesetsRecomputed: seenVersions.size,
      inserted,
      updated,
      skipped,
    };
  });
}
