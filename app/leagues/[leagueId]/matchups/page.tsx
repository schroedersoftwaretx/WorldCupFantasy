/**
 * Matchups page (Phase 9 Priority 2 UI).
 *
 * The league's head-to-head view: the ranked W-D-L table, every matchup
 * grouped by scoring period (live points until the period finalizes), and
 * pairwise rivalry records. Everything is derived from the same period
 * totals as the standings page. Owner gets the generate/regenerate button
 * (regeneration locks once a period finalizes - the API enforces it).
 *
 * Auth-gated, membership-gated, and hidden unless the head_to_head flag is
 * on. Force-dynamic: results recompute from the latest score_entry rows.
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import { computeH2h, type H2hView } from "@/data/h2h/results";
import { getSchedule } from "@/data/h2h/schedule";
import { getFlags } from "@/data/league/feature-flags";
import { getCurrentUser } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { formatPoints } from "@/web/format";
import { getMembershipRole } from "@/web/queries";

import LeagueTabs from "../league-tabs";
import GenerateScheduleButton from "./generate-schedule-button";

export const dynamic = "force-dynamic";

export default async function MatchupsPage({
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
  if (!flags.head_to_head) {
    return (
      <main className="container">
        <LeagueTabs leagueId={id} isOwner={isOwner} current="matchups" />
        <h1>Matchups</h1>
        <p className="notice">
          Head-to-head is not enabled for this league.
          {isOwner ? " Turn it on in Settings to get started." : ""}
        </p>
      </main>
    );
  }

  let view: H2hView | null = null;
  let scheduled = false;
  let error: string | null = null;
  try {
    view = await computeH2h(db, id);
    scheduled = (await getSchedule(db, id)).length > 0;
  } catch (e) {
    error = e instanceof Error ? e.message : "could not compute matchups";
  }

  if (error || !view) {
    return (
      <main className="container">
        <LeagueTabs leagueId={id} isOwner={isOwner} current="matchups" />
        <h1>Matchups</h1>
        <p className="error">Could not load matchups: {error}</p>
      </main>
    );
  }

  const nameByTeam = new Map(view.table.map((t) => [t.fantasyTeamId, t.teamName]));
  const teamName = (teamId: number) => nameByTeam.get(teamId) ?? `Team #${teamId}`;
  const byOrdinal = new Map<number, typeof view.results>();
  for (const r of view.results) {
    const list = byOrdinal.get(r.ordinal) ?? [];
    list.push(r);
    byOrdinal.set(r.ordinal, list);
  }

  return (
    <main className="container">
      <Link href={`/leagues/${id}`} className="back-link">
        &larr; League
      </Link>
      <LeagueTabs leagueId={id} isOwner={isOwner} current="matchups" />
      <h1>Matchups</h1>
      <p className="subtitle">
        Weekly head-to-head: win 3 &middot; draw 1 &middot; loss 0. Results
        finalize when every fixture of a period has finished.
        {isOwner ? (
          <>
            {" "}
            <GenerateScheduleButton leagueId={id} scheduled={scheduled} />
          </>
        ) : null}
      </p>

      {!scheduled ? (
        <p className="notice">
          No schedule yet.
          {isOwner
            ? " Generate one to pair teams for every scoring period."
            : " Ask the league owner to generate one."}
        </p>
      ) : (
        <>
          <h2>Table</h2>
          <div
            className="table-scroll"
            tabIndex={0}
            role="region"
            aria-label="Scrollable head-to-head table"
          >
            <table>
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Team</th>
                  <th className="num">P</th>
                  <th className="num">W</th>
                  <th className="num">D</th>
                  <th className="num">L</th>
                  <th className="num">Pts</th>
                  <th className="num">Season pts</th>
                </tr>
              </thead>
              <tbody>
                {view.table.map((t) => (
                  <tr key={t.fantasyTeamId}>
                    <td className="num">{t.rank}</td>
                    <td>{t.teamName}</td>
                    <td className="num">{t.played}</td>
                    <td className="num">{t.wins}</td>
                    <td className="num">{t.draws}</td>
                    <td className="num">{t.losses}</td>
                    <td className="num">{t.h2hPoints}</td>
                    <td className="num">{formatPoints(t.totalPoints)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2>Fixtures</h2>
          {view.periods
            .filter((p) => (byOrdinal.get(p.ordinal) ?? []).length > 0)
            .map((p) => (
              <section key={p.ordinal}>
                <h3>
                  {p.label}{" "}
                  {p.finalized ? (
                    <span className="tag">Final</span>
                  ) : (
                    <span className="tag tag-projected">Live</span>
                  )}
                </h3>
                <div
                  className="table-scroll"
                  tabIndex={0}
                  role="region"
                  aria-label={`Matchups for ${p.label}`}
                >
                  <table>
                    <tbody>
                      {(byOrdinal.get(p.ordinal) ?? []).map((m) => (
                        <tr key={m.matchupId}>
                          <td>
                            {teamName(m.homeFantasyTeamId)}
                            {m.outcome === "HOME" ? " \u{1F3C6}" : ""}
                          </td>
                          <td className="num">{formatPoints(m.homePoints)}</td>
                          <td className="num">&ndash;</td>
                          <td className="num">{formatPoints(m.awayPoints)}</td>
                          <td>
                            {teamName(m.awayFantasyTeamId)}
                            {m.outcome === "AWAY" ? " \u{1F3C6}" : ""}
                          </td>
                          <td>{m.outcome === "DRAW" ? "Draw" : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}

          {view.rivalries.length > 0 ? (
            <>
              <h2>Rivalries</h2>
              <ul>
                {view.rivalries.map((r) => (
                  <li key={`${r.teamAId}:${r.teamBId}`}>
                    {teamName(r.teamAId)} {r.aWins}&ndash;{r.bWins}{" "}
                    {teamName(r.teamBId)}
                    {r.draws > 0 ? ` (${r.draws} drawn)` : ""}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}
    </main>
  );
}
