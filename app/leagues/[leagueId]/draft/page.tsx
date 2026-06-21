/**
 * Draft room page.
 *
 * A thin Server Component: auth + membership gate, then it hands off to the
 * <DraftRoom> client component, which fetches and polls the draft state.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { league } from "@/data/db/schema";
import type { ScoringRuleset } from "@/data/scoring/ruleset";
import { getCurrentUser } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { getMembershipRole } from "@/web/queries";

import DraftRoom from "./draft-room";

export const dynamic = "force-dynamic";

export default async function DraftPage({
  params,
}: {
  params: Promise<{ leagueId: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { leagueId } = await params;
  const id = Number(leagueId);
  const validId = Number.isInteger(id) && id > 0;

  const back = (
    <Link href={validId ? `/leagues/${id}` : "/"} className="back-link">
      &larr; {validId ? "Back to league" : "Your leagues"}
    </Link>
  );

  if (!validId) {
    return (
      <>
        {back}
        <p className="error">Invalid league id: {leagueId}</p>
      </>
    );
  }

  const db = getDb();
  let role: string | null = null;
  let ruleset: ScoringRuleset | null = null;
  let error: string | null = null;
  try {
    role = await getMembershipRole(db, id, user.manager.id);
    const [lg] = await db.select().from(league).where(eq(league.id, id));
    ruleset = lg ? (lg.scoringRuleset as ScoringRuleset) : null;
  } catch (e) {
    error = e instanceof Error ? e.message : "could not load the draft";
  }

  if (error) {
    return (
      <>
        {back}
        <p className="error">{error}</p>
      </>
    );
  }
  if (!role || !ruleset) {
    return (
      <>
        {back}
        <p className="notice">League not found, or you are not a member.</p>
      </>
    );
  }

  return (
    <>
      {back}
      <DraftRoom leagueId={id} ruleset={ruleset} />
    </>
  );
}
