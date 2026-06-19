/**
 * Stats Hub awards section (Phase 7.1) - PUBLIC, tournament-wide.
 *
 * The global, player-attributed awards (Golden Boot, Playmaker, Golden Glove,
 * biggest single-match haul), scored against HUB_RULESET_VERSION like the rest
 * of the Stats Hub. Not login-gated and not league-specific.
 *
 * URL: /stats/awards
 */
import Link from "next/link";

import { computeGlobalAwards, type AwardResult } from "@/data/awards/registry";
import { getDb } from "@/web/db";
import { HUB_RULESET_VERSION } from "@/web/stats-params";

import { AwardsBoard } from "../../awards-board";

export const dynamic = "force-dynamic";

export default async function StatsAwardsPage() {
  let awards: AwardResult[] = [];
  let error: string | null = null;
  try {
    const db = getDb();
    awards = await computeGlobalAwards(db, {
      rulesetVersion: HUB_RULESET_VERSION,
    });
  } catch (e) {
    error = e instanceof Error ? e.message : "could not load awards";
  }

  return (
    <>
      <Link href="/stats" className="back-link">
        &larr; Back to Stats Hub
      </Link>
      <h1>Tournament Awards</h1>
      <p className="subtitle">
        The races for the tournament&apos;s individual honours &mdash; top
        scorer, assist king, best goalkeeper, and the biggest single-match
        haul. For your league&apos;s own Trophy Room, open the Awards tab in
        your league.
      </p>
      {error ? (
        <p className="error">Could not load awards: {error}</p>
      ) : (
        <AwardsBoard awards={awards} />
      )}
    </>
  );
}
