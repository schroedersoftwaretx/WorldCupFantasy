/**
 * Public Draft Trends page (Phase 2.2).
 *
 * Tournament-wide draft analytics: every drafted player's ADP, take-rate,
 * reach/steal vs their pre-tournament rank, and cross-league ownership %.
 * No login required (like the rest of the Stats Hub). Aggregate-only: it never
 * shows which league or team drafted/owns a player.
 */
import Link from "next/link";

import { getDraftTrends, type DraftTrends } from "@/data/stats/hub";
import { getDb } from "@/web/db";

import { DraftTrendsTable } from "./trends-table";

export const dynamic = "force-dynamic";

export default async function DraftTrendsPage() {
  let data: DraftTrends | null = null;
  let error: string | null = null;
  try {
    const db = getDb();
    data = await getDraftTrends(db);
  } catch (e) {
    error = e instanceof Error ? e.message : "could not load draft trends";
  }

  return (
    <>
      <Link href="/stats" className="back-link">
        &larr; Stats Hub
      </Link>
      <h1>Draft Trends</h1>

      {error ? (
        <p className="error">Could not load: {error}</p>
      ) : !data || data.rows.length === 0 ? (
        <p className="notice">
          No drafts have happened yet. This fills in once leagues start drafting.
        </p>
      ) : (
        <DraftTrendsTable
          rows={data.rows}
          totalDrafts={data.totalDrafts}
          totalFantasyTeams={data.totalFantasyTeams}
        />
      )}
    </>
  );
}
