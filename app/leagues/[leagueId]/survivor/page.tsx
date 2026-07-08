/**
 * Survivor page (phase-05 5.2 UI) - the league's survivor pool, behind the
 * survivor flag. Pick one nation to WIN each stage; no reuse; wrong or
 * missed picks cost a life.
 */
import Link from "next/link";
import { asc } from "drizzle-orm";
import { redirect } from "next/navigation";

import { fixture, nationalTeam, stageEnum } from "@/data/db/schema";
import { getFlags } from "@/data/league/feature-flags";
import { getSurvivorBoard } from "@/data/sidegames/survivor";
import { getCurrentUser } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { getMembershipRole } from "@/web/queries";

import LeagueTabs from "../league-tabs";
import SurvivorPanel, { type SurvivorBoardRow } from "./survivor-panel";

export const dynamic = "force-dynamic";

export default async function SurvivorPage({
  params,
}: {
  params: Promise<{ leagueId: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { leagueId } = await params;
  const id = Number.parseInt(leagueId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return (
      <main className="container">
        <p className="error">Invalid league id: {leagueId}</p>
      </main>
    );
  }

  const db = getDb();
  const role = await getMembershipRole(db, id, user.manager.id);
  if (!role) {
    return (
      <main className="container">
        <p className="notice">League not found, or you are not a member.</p>
      </main>
    );
  }
  const isOwner = role === "OWNER";

  const flags = await getFlags(db, id);
  if (!flags.survivor) {
    return (
      <main className="container">
        <LeagueTabs leagueId={id} isOwner={isOwner} current="survivor" />
        <h1>Survivor</h1>
        <p className="notice">
          Survivor is not enabled for this league.
          {isOwner ? " Turn it on in Settings to get started." : ""}
        </p>
      </main>
    );
  }

  const board = (await getSurvivorBoard(db, id, user.manager.id)) as SurvivorBoardRow[];
  const teams = await db
    .select({ id: nationalTeam.id, name: nationalTeam.name, status: nationalTeam.status })
    .from(nationalTeam)
    .orderBy(asc(nationalTeam.name));
  const kicks = await db
    .select({ stage: fixture.stage, kickoffUtc: fixture.kickoffUtc })
    .from(fixture);
  const stageLocksAtUtc: Record<string, string> = {};
  for (const k of kicks) {
    const iso = k.kickoffUtc.toISOString();
    const cur = stageLocksAtUtc[k.stage];
    if (!cur || iso < cur) stageLocksAtUtc[k.stage] = iso;
  }

  return (
    <main className="container">
      <Link href={`/leagues/${id}`} className="back-link">
        &larr; League
      </Link>
      <LeagueTabs leagueId={id} isOwner={isOwner} current="survivor" />
      <h1>Survivor pool</h1>
      <p className="subtitle">
        Pick one nation to WIN each stage. Each nation once; a wrong or
        missed pick costs a life; picks lock at the stage&apos;s first
        kickoff and stay hidden from rivals until then.
      </p>
      <SurvivorPanel
        leagueId={id}
        viewerManagerId={user.manager.id}
        board={board}
        teams={teams}
        stageLocksAtUtc={stageLocksAtUtc}
        stages={[...stageEnum.enumValues]}
      />
    </main>
  );
}
