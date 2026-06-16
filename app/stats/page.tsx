/**
 * Stats landing (nav shell, Phase 0).
 *
 * The top-level entry point for the tournament Stats Hub that Phase 1 fills in
 * (Team of the Matchday/Stage, leaderboards, records). For now it confirms the
 * destination exists and routes a signed-in manager to their leagues, whose
 * standings already expose per-stage data via the aggregate layer.
 */
import Link from "next/link";

import { getCurrentUser } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { listLeaguesForManager } from "@/web/queries";
import type { LeagueSummary } from "@/web/api-types";

export const dynamic = "force-dynamic";

export default async function StatsPage() {
  const user = await getCurrentUser();

  let leagues: LeagueSummary[] = [];
  if (user) {
    try {
      leagues = await listLeaguesForManager(getDb(), user.manager.id);
    } catch {
      leagues = [];
    }
  }

  return (
    <>
      <h1>Tournament Stats</h1>
      <p className="subtitle">
        Leaderboards, Team of the Stage, and records arrive with the Stats Hub.
        For now, jump into a league to see its standings and per-stage points.
      </p>
      {!user ? (
        <p className="notice">
          <Link href="/login">Sign in</Link> to see your leagues.
        </p>
      ) : leagues.length === 0 ? (
        <p className="notice">You are not in any leagues yet.</p>
      ) : (
        <ul className="league-list">
          {leagues.map((l) => (
            <li key={l.id}>
              <Link href={`/leagues/${l.id}/standings`}>{l.name}</Link>{" "}
              <span className="tag">{l.status}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
