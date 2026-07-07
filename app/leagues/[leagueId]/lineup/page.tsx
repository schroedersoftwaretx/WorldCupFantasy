/**
 * Lineup page (Phase 9 Priority 1 UI) - SET_LINEUP leagues only.
 *
 * The signed-in manager sets their starting XI + captain/vice per scoring
 * period; submissions lock at the period's first kickoff and roll forward
 * to later periods until replaced. Other formats get a notice.
 */
import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import {
  assignFixturesToPeriods,
  getScoringPeriods,
} from "@/data/competition/periods";
import { fantasyTeam, fixture, league, player, rosterSlot } from "@/data/db/schema";
import { getLineups } from "@/data/lineup/service";
import { getCurrentUser } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { getMembershipRole } from "@/web/queries";

import LeagueTabs from "../league-tabs";
import LineupEditor, {
  type ExistingLineup,
  type LineupPeriod,
  type LineupRosterPlayer,
} from "./lineup-editor";

export const dynamic = "force-dynamic";

export default async function LineupPage({
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

  const [lg] = await db.select().from(league).where(eq(league.id, id));
  if (!lg || lg.format !== "SET_LINEUP") {
    return (
      <main className="container">
        <LeagueTabs leagueId={id} isOwner={isOwner} current="lineup" />
        <h1>Lineup</h1>
        <p className="notice">
          This league uses best-ball scoring - the optimal XI is picked
          automatically each period, so there is no lineup to set.
        </p>
      </main>
    );
  }

  const [team] = await db
    .select()
    .from(fantasyTeam)
    .where(and(eq(fantasyTeam.leagueId, id), eq(fantasyTeam.managerId, user.manager.id)));
  if (!team) {
    return (
      <main className="container">
        <LeagueTabs leagueId={id} isOwner={isOwner} current="lineup" />
        <h1>Lineup</h1>
        <p className="notice">You do not have a team in this league.</p>
      </main>
    );
  }

  const slots = await db
    .select({
      playerId: rosterSlot.playerId,
      fullName: player.fullName,
      position: player.position,
    })
    .from(rosterSlot)
    .innerJoin(player, eq(player.id, rosterSlot.playerId))
    .where(eq(rosterSlot.fantasyTeamId, team.id));
  const roster: LineupRosterPlayer[] = slots
    .map((s) => ({ playerId: s.playerId, fullName: s.fullName, position: s.position }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));

  const refs = await getScoringPeriods(db, lg.competitionId);
  const fixtures = await db.select().from(fixture);
  const assigned = assignFixturesToPeriods(refs, fixtures);
  const firstKickoffByOrdinal = new Map<number, Date>();
  for (const f of fixtures) {
    const ord = assigned.get(f.id);
    if (ord === undefined) continue;
    const cur = firstKickoffByOrdinal.get(ord);
    if (!cur || f.kickoffUtc < cur) firstKickoffByOrdinal.set(ord, f.kickoffUtc);
  }
  const periods: LineupPeriod[] = refs
    .filter((p): p is typeof p & { id: number } => p.id !== null)
    .map((p) => ({
      scoringPeriodId: p.id,
      ordinal: p.ordinal,
      label: p.label,
      locksAtUtc: firstKickoffByOrdinal.get(p.ordinal)?.toISOString() ?? null,
    }));

  const rows = await getLineups(db, team.id);
  const lineups: ExistingLineup[] = rows.map((r) => ({
    scoringPeriodId: r.scoringPeriodId,
    playerIds: r.playerIds as number[],
    captainPlayerId: r.captainPlayerId,
    viceCaptainPlayerId: r.viceCaptainPlayerId,
  }));

  return (
    <main className="container">
      <Link href={`/leagues/${id}`} className="back-link">
        &larr; League
      </Link>
      <LeagueTabs leagueId={id} isOwner={isOwner} current="lineup" />
      <h1>Set your lineup</h1>
      <p className="subtitle">
        {team.name}: pick 11 (1 GK, DEF 4-5, MID 2-4, FWD 2-3), name a captain
        (double points; vice steps in if the captain doesn&apos;t play). Locks
        at the period&apos;s first kickoff; unsaved periods reuse your most
        recent lineup.
      </p>
      <LineupEditor
        leagueId={id}
        teamId={team.id}
        roster={roster}
        periods={periods}
        lineups={lineups}
      />
    </main>
  );
}
