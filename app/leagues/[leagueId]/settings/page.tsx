/**
 * League settings - Features panel (Phase 0). Owner-only.
 *
 * Server component: auth + owner gating, then loads the league's flag states
 * through the typed helper and hands them to the client FeaturesPanel. A
 * non-owner member sees an owner-only notice; a non-member sees not-found.
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import { getFlagStates } from "@/data/league/feature-flags";
import { getCurrentUser } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { getMembershipRole } from "@/web/queries";

import FeaturesPanel from "./features-panel";

export const dynamic = "force-dynamic";

export default async function LeagueSettingsPage({
  params,
}: {
  params: Promise<{ leagueId: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { leagueId } = await params;
  const id = Number(leagueId);

  const back = (
    <Link href={`/leagues/${id}`} className="back-link">
      &larr; League
    </Link>
  );

  if (!Number.isInteger(id) || id <= 0) {
    return (
      <>
        {back}
        <p className="error">Invalid league id: {leagueId}</p>
      </>
    );
  }

  const db = getDb();
  const role = await getMembershipRole(db, id, user.manager.id);
  if (!role) {
    return (
      <>
        {back}
        <p className="notice">League not found, or you are not a member.</p>
      </>
    );
  }
  if (role !== "OWNER") {
    return (
      <>
        {back}
        <p className="notice">Only the league owner can change features.</p>
      </>
    );
  }

  const flags = await getFlagStates(db, id);

  return (
    <>
      {back}
      <h1>League settings</h1>
      <h2>Features</h2>
      <p className="subtitle">
        Turn on optional features for this league. Everything is off by default,
        keeping a plain best-ball league unchanged.
      </p>
      <FeaturesPanel
        leagueId={id}
        initial={Object.fromEntries(
          Object.entries(flags).map(([k, v]) => [k, v.enabled]),
        )}
      />
    </>
  );
}
