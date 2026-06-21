/**
 * Owner-only league scoring editor.
 *
 * Loads the league's current scoring ruleset and renders the editable form.
 * Saving PUTs to /api/leagues/[leagueId]/scoring, which re-versions the ruleset
 * and recomputes scores. Non-owners get a read-only notice.
 *
 * URL: /leagues/[leagueId]/scoring
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { league } from "@/data/db/schema";
import type { ScoringRuleset } from "@/data/scoring/ruleset";
import { getCurrentUser } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { getMembershipRole } from "@/web/queries";

import ScoringEditor from "./scoring-editor";

export const dynamic = "force-dynamic";

export default async function LeagueScoringPage({
  params,
}: {
  params: Promise<{ leagueId: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { leagueId } = await params;
  const id = Number(leagueId);
  const back = (
    <Link href={`/leagues/${leagueId}/standings`} className="back-link">
      &larr; Standings
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
        <p className="notice">League {id} not found.</p>
      </>
    );
  }

  const [lg] = await db.select().from(league).where(eq(league.id, id));
  if (!lg) {
    return (
      <>
        {back}
        <p className="notice">League {id} not found.</p>
      </>
    );
  }

  const ruleset = lg.scoringRuleset as ScoringRuleset;

  if (role !== "OWNER") {
    return (
      <>
        {back}
        <h1>Scoring rules &mdash; {lg.name}</h1>
        <p className="notice">
          Only the league owner can edit scoring. The active ruleset version is{" "}
          <code>{ruleset.version}</code>.
        </p>
      </>
    );
  }

  return (
    <>
      {back}
      <h1>Edit scoring &mdash; {lg.name}</h1>
      <p className="subtitle">
        Change any point value below and save. The ruleset is re-versioned and
        every team&apos;s scores are recomputed immediately. Current version:{" "}
        <code>{ruleset.version}</code>.
      </p>
      <ScoringEditor leagueId={id} ruleset={ruleset} />
    </>
  );
}
