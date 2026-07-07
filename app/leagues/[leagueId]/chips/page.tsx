/**
 * Chips page (Phase 9 Priority 3 UI).
 *
 * The signed-in manager's chips & captain panel: nominate a period captain
 * (best-ball leagues), spend one-shot chips, see what's left. Hidden unless
 * the chips feature flag is on.
 */
import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { getChipState } from "@/data/chips/service";
import {
  assignFixturesToPeriods,
  getScoringPeriods,
} from "@/data/competition/periods";
import { fantasyTeam, fixture, league, player, rosterSlot } from "@/data/db/schema";
import { getFlags } from "@/data/league/feature-flags";
import { getCurrentUser } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { getMembershipRole } from "@/web/queries";

import LeagueTabs from "../league-tabs";
import ChipsPanel, {
  type CaptainPick,
  type ChipsPeriod,
  type ChipsRosterPlayer,
  type PlayedChip,
} from "./chips-panel";

export const dynamic = "force-dynamic";

export default async function ChipsPage({
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
  if (!flags.chips) {
    return (
      <main className="container">
        <LeagueTabs leagueId={id} isOwner={isOwner} current="chips" />
        <h1>Chips</h1>
        <p className="notice">
          Chips are not enabled for this league.
          {isOwner ? " Turn them on in Settings to get started." : ""}
        </p>
      </main>
    );
  }

  const [lg] = await db.select().from(league).where(eq(league.id, id));
  const [team] = await db
    .select()
    .from(fantasyTeam)
    .where(and(eq(fantasyTeam.leagueId, id), eq(fantasyTeam.managerId, user.manager.id)));
  if (!lg || !team) {
    return (
      <main className="container">
        <LeagueTabs leagueId={id} isOwner={isOwner} current="chips" />
        <h1>Chips</h1>
        <p className="notice">You do not have a team in this league.</p>
      </main>
    );
  }

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
  const periods: ChipsPeriod[] = refs
    .filter((p): p is typeof p & { id: number } => p.id !== null)
    .map((p) => ({
      scoringPeriodId: p.id,
      ordinal: p.ordinal,
      label: p.label,
      locksAtUtc: firstKickoffByOrdinal.get(p.ordinal)?.toISOString() ?? null,
    }));

  const slots = await db
    .select({
      playerId: rosterSlot.playerId,
      fullName: player.fullName,
      position: player.position,
    })
    .from(rosterSlot)
    .innerJoin(player, eq(player.id, rosterSlot.playerId))
    .where(eq(rosterSlot.fantasyTeamId, team.id));
  const roster: ChipsRosterPlayer[] = slots
    .map((s) => ({ playerId: s.playerId, fullName: s.fullName, position: s.position }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));

  const state = await getChipState(db, team.id);
  const played: PlayedChip[] = state.played.map((p) => ({
    chip: p.chip,
    scoringPeriodId: p.scoringPeriodId,
  }));
  const captains: CaptainPick[] = state.captains.map((c) => ({
    scoringPeriodId: c.scoringPeriodId,
    playerId: c.playerId,
  }));

  return (
    <main className="container">
      <Link href={`/leagues/${id}`} className="back-link">
        &larr; League
      </Link>
      <LeagueTabs leagueId={id} isOwner={isOwner} current="chips" />
      <h1>Chips &amp; Captain</h1>
      <p className="subtitle">{team.name}</p>
      <ChipsPanel
        leagueId={id}
        teamId={team.id}
        format={lg.format}
        periods={periods}
        roster={roster}
        played={played}
        remaining={state.remaining}
        captains={captains}
      />
    </main>
  );
}
