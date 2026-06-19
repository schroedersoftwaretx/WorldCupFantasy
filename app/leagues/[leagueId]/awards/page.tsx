/**
 * Trophy Room page (Phase 7.1) - per league, membership-gated.
 *
 * Renders the current leaders of every derived tournament award for this
 * league. Awards are scored against the league's OWN ruleset version so the
 * points line up with the standings/roster surfaces. Nothing is stored: the
 * board recomputes from score_entry / stat_line / rosters on each view.
 *
 * URL: /leagues/[leagueId]/awards
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { computeTrophyRoom, type AwardResult } from "@/data/awards/registry";
import { league } from "@/data/db/schema";
import type { ScoringRuleset } from "@/data/scoring/ruleset";
import { getCurrentUser } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { getMembershipRole } from "@/web/queries";

import { AwardsBoard } from "../../../awards-board";

export const dynamic = "force-dynamic";

export default async function TrophyRoomPage({
  params,
}: {
  params: Promise<{ leagueId: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { leagueId } = await params;
  const lgId = Number(leagueId);
  const validId = Number.isInteger(lgId) && lgId > 0;

  const back = (
    <Link href={validId ? `/leagues/${lgId}` : "/"} className="back-link">
      &larr; {validId ? "Back to league" : "Your leagues"}
    </Link>
  );

  if (!validId) {
    return (
      <>
        {back}
        <p className="error">Invalid league id.</p>
      </>
    );
  }

  let role: string | null = null;
  let awards: AwardResult[] = [];
  let error: string | null = null;

  try {
    const db = getDb();
    role = await getMembershipRole(db, lgId, user.manager.id);
    if (role) {
      const [lg] = await db.select().from(league).where(eq(league.id, lgId));
      if (lg) {
        const rulesetVersion = (lg.scoringRuleset as ScoringRuleset).version;
        awards = await computeTrophyRoom(db, { leagueId: lgId, rulesetVersion });
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : "could not load awards";
  }

  if (error) {
    return (
      <>
        {back}
        <p className="error">Could not load the Trophy Room: {error}</p>
      </>
    );
  }
  if (!role) {
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
      <h1>Trophy Room</h1>
      <p className="subtitle">
        Season-long awards running parallel to the overall standings &mdash;
        player awards go to the manager who rosters the scorer. Leaders are
        live and update as results come in.
      </p>
      <AwardsBoard awards={awards} />
    </>
  );
}
