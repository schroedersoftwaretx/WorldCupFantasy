/**
 * Admin: per-fixture stat editor.
 *
 * Loads both squads for the fixture and any existing stat lines, then renders
 * the client-side editor table. A player with no stat line yet shows zeros and
 * a row can still be saved (it will be created, flagged manually-edited).
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { eq, inArray } from "drizzle-orm";

import { fixture, nationalTeam, player, statLine } from "@/data/db/schema";
import { getAdminUser } from "@/web/auth/admin";
import { getDb } from "@/web/db";

import StatEditor, { type EditorRow } from "./stat-editor";

export const dynamic = "force-dynamic";

export default async function AdminFixtureStats({
  params,
}: {
  params: Promise<{ fixtureId: string }>;
}) {
  const user = await getAdminUser();
  if (!user) redirect("/login");

  const { fixtureId } = await params;
  const id = Number(fixtureId);
  const back = (
    <Link href="/admin/stats" className="back-link">
      &larr; All fixtures
    </Link>
  );
  if (!Number.isInteger(id) || id <= 0) {
    return (
      <>
        {back}
        <p className="error">Invalid fixture id: {fixtureId}</p>
      </>
    );
  }

  const db = getDb();
  const [fx] = await db.select().from(fixture).where(eq(fixture.id, id));
  if (!fx) {
    return (
      <>
        {back}
        <p className="notice">Fixture {id} not found.</p>
      </>
    );
  }

  const teams = await db
    .select()
    .from(nationalTeam)
    .where(inArray(nationalTeam.id, [fx.homeTeamId, fx.awayTeamId]));
  const teamName = new Map(teams.map((t) => [t.id, t.name]));

  const players = await db
    .select()
    .from(player)
    .where(inArray(player.nationalTeamId, [fx.homeTeamId, fx.awayTeamId]));

  const lines = await db.select().from(statLine).where(eq(statLine.fixtureId, id));
  const lineByPlayer = new Map(lines.map((l) => [l.playerId, l]));

  const rows: EditorRow[] = players
    .map((p) => {
      const l = lineByPlayer.get(p.id);
      return {
        playerId: p.id,
        fullName: p.fullName,
        position: p.position,
        teamName: teamName.get(p.nationalTeamId) ?? "",
        manuallyEdited: l?.manuallyEdited ?? false,
        stat: {
          minutesPlayed: l?.minutesPlayed ?? 0,
          goals: l?.goals ?? 0,
          assists: l?.assists ?? 0,
          saves: l?.saves ?? 0,
          yellowCards: l?.yellowCards ?? 0,
          redCards: l?.redCards ?? 0,
          penaltiesScored: l?.penaltiesScored ?? 0,
          penaltiesMissed: l?.penaltiesMissed ?? 0,
          penaltiesSaved: l?.penaltiesSaved ?? 0,
          ownGoals: l?.ownGoals ?? 0,
          teamConcededInRegulationAndEt: l?.teamConcededInRegulationAndEt ?? 0,
          teamScoredInRegulationAndEt: l?.teamScoredInRegulationAndEt ?? 0,
          shotsOnTarget: l?.shotsOnTarget ?? 0,
          shotsOffTarget: l?.shotsOffTarget ?? 0,
          tacklesSuccessful: l?.tacklesSuccessful ?? 0,
          crosses: l?.crosses ?? 0,
          passesCompleted: l?.passesCompleted ?? 0,
          goalsConceded: l?.goalsConceded ?? 0,
        },
      };
    })
    .sort((a, b) => a.teamName.localeCompare(b.teamName) || a.fullName.localeCompare(b.fullName));

  const title = `${teamName.get(fx.homeTeamId) ?? "?"} v ${teamName.get(fx.awayTeamId) ?? "?"}`;

  return (
    <>
      {back}
      <h1>Edit stats &mdash; {title}</h1>
      <p className="subtitle">
        Saving a row locks it against provider re-ingest and recomputes scores.
        API-Football has no <strong>crosses</strong> data, so enter the{" "}
        <strong>Crs</strong> column by hand (e.g. from FBref). For a goalkeeper
        substitution, split <strong>saves</strong> and{" "}
        <strong>goals conceded</strong> between the two keepers.
      </p>
      <StatEditor fixtureId={id} rows={rows} />
    </>
  );
}
