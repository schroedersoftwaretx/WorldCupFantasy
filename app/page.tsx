/**
 * Dashboard: the signed-in manager's leagues, plus a create-league form.
 *
 * Auth-gated (W2); the league list is scoped to the caller's memberships
 * (W3). A Server Component reading the data layer directly.
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import type { LeagueSummary } from "@/web/api-types";
import { getCurrentUser } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { listLeaguesForManager } from "@/web/queries";

import CreateLeagueForm from "./create-league-form";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  let leagues: LeagueSummary[] = [];
  let error: string | null = null;
  try {
    leagues = await listLeaguesForManager(getDb(), user.manager.id);
  } catch (e) {
    error = e instanceof Error ? e.message : "could not load leagues";
  }

  return (
    <>
      <h1>Your leagues</h1>
      <p className="subtitle">Signed in as {user.manager.displayName}.</p>

      {error ? (
        <p className="error">Could not load leagues: {error}</p>
      ) : leagues.length === 0 ? (
        <p className="notice">
          You are not in any leagues yet. Create one below, or open an invite
          link from a friend.
        </p>
      ) : (
        <ul className="card-list">
          {leagues.map((lg) => (
            <li key={lg.id}>
              <Link href={`/leagues/${lg.id}`} className="card">
                <span className="card-title">{lg.name}</span>
                <span className="tag">{lg.status}</span>
                <div className="card-meta">
                  {lg.memberCount} / {lg.maxManagers} managers &middot;{" "}
                  {lg.rosterSize}-player rosters
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <CreateLeagueForm />
    </>
  );
}
