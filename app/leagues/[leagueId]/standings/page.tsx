/**
 * Standings page (W5 enhanced).
 *
 * Shows:
 *   1. The ranked standings table (cumulative best-ball totals + tie-breakers)
 *   2. A per-period breakdown table with expandable best-ball XI detail for
 *      each team x period using native <details>/<summary> — no client JS.
 *   3. Links to each team's roster detail page.
 *   4. For the league owner: a "Recompute scores" button that calls the
 *      manual recompute API so standings reflect freshly ingested stats.
 *
 * Auth-gated and membership-gated (W3). Force-dynamic so every load
 * recomputes standings from the latest score_entry rows.
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import { computeStandings } from "@/data/standings/standings";
import type { StandingsEntry } from "@/data/standings/standings";
import type { LeagueDetail } from "@/web/api-types";
import { getCurrentUser } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { getLeagueDetail, getMembershipRole } from "@/web/queries";

import RecomputeButton from "./recompute-button";

export const dynamic = "force-dynamic";

/** Short, column-friendly labels for the nine scoring periods. */
const STAGE_LABEL: Record<string, string> = {
  GROUP_1: "G1",
  GROUP_2: "G2",
  GROUP_3: "G3",
  R32: "R32",
  R16: "R16",
  QF: "QF",
  SF: "SF",
  THIRD_PLACE: "3rd",
  FINAL: "Final",
};

const STAGE_FULL: Record<string, string> = {
  GROUP_1: "Group Stage MD1",
  GROUP_2: "Group Stage MD2",
  GROUP_3: "Group Stage MD3",
  R32: "Round of 32",
  R16: "Round of 16",
  QF: "Quarter-finals",
  SF: "Semi-finals",
  THIRD_PLACE: "Third-place playoff",
  FINAL: "Final",
};

export default async function StandingsPage({
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

  let role: string | null = null;
  let detail: LeagueDetail | null = null;
  let standings: StandingsEntry[] = [];
  let error: string | null = null;
  try {
    const db = getDb();
    role = await getMembershipRole(db, id, user.manager.id);
    if (role) {
      detail = await getLeagueDetail(db, id);
      if (detail) {
        standings = await computeStandings(db, id);
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : "could not load standings";
  }

  if (error) {
    return (
      <>
        {back}
        <p className="error">Could not load standings: {error}</p>
      </>
    );
  }
  if (!role || !detail) {
    return (
      <>
        {back}
        <p className="notice">League not found, or you are not a member.</p>
      </>
    );
  }

  const isOwner = role === "OWNER";
  const teamById = new Map(
    detail.members.map((m) => [m.teamId, m]),
  );
  const nameByManager = new Map(
    detail.members.map((m) => [m.managerId, m.displayName]),
  );
  // map fantasyTeamId -> teamId (for roster link)
  const teamIdByFantasyTeam = new Map(
    detail.members
      .filter((m) => m.teamId !== null)
      .map((m) => [m.teamId as number, m.teamId as number]),
  );

  const periods = standings[0]?.periods ?? [];
  // Only show periods that have any non-zero points.
  const activePeriods = periods.filter((p) =>
    standings.some((e) => e.periods.find((ep) => ep.stage === p.stage)?.points ?? 0 > 0),
  );
  const allPeriods = periods; // always show all columns even if 0

  return (
    <>
      {back}
      <h1>
        {detail.name}
        <span className="tag">{detail.status}</span>
      </h1>
      <p className="subtitle">
        Standings &mdash; cumulative best-ball totals. Recomputed live on every
        load.{" "}
        <Link href={`/leagues/${id}/standings`} className="refresh-link">
          Refresh &uarr;
        </Link>
      </p>

      {isOwner && (
        <div className="recompute-banner">
          <span>
            Owner: recompute scores from the latest ingested match stats.
          </span>
          <RecomputeButton leagueId={id} />
        </div>
      )}

      {standings.length === 0 ? (
        <p className="notice">
          No teams in this league yet. Standings appear once managers join and
          draft their rosters.
        </p>
      ) : (
        <>
          {/* ---- Overall rankings table ---- */}
          <h2>Overall standings</h2>
          <table>
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Team</th>
                <th>Manager</th>
                <th className="num">Total</th>
                <th className="num">Final pts</th>
                <th className="num">Goals</th>
                <th className="num">Assists</th>
              </tr>
            </thead>
            <tbody>
              {standings.map((entry) => (
                <tr key={entry.fantasyTeamId}>
                  <td className="num">{entry.rank}</td>
                  <td>
                    <Link
                      href={`/leagues/${id}/roster/${entry.fantasyTeamId}`}
                      className="team-link"
                    >
                      {entry.teamName}
                    </Link>
                  </td>
                  <td>
                    {nameByManager.get(entry.managerId) ??
                      `manager #${entry.managerId}`}
                  </td>
                  <td className="num">{entry.total}</td>
                  <td className="num">{entry.tieBreakers.finalMatchPoints}</td>
                  <td className="num">{entry.tieBreakers.tournamentGoals}</td>
                  <td className="num">
                    {entry.tieBreakers.tournamentAssists}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* ---- Per-period breakdown with expandable XI ---- */}
          <h2>Best-ball points by scoring period</h2>
          <p className="subtitle">
            Click a cell to reveal that team&rsquo;s best-ball XI for that
            period.
          </p>
          <table className="period-table">
            <thead>
              <tr>
                <th>Team</th>
                {allPeriods.map((p) => (
                  <th key={p.stage} className="num">
                    {STAGE_LABEL[p.stage] ?? p.stage}
                  </th>
                ))}
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {standings.map((entry) => (
                <tr key={entry.fantasyTeamId}>
                  <td>
                    <Link
                      href={`/leagues/${id}/roster/${entry.fantasyTeamId}`}
                      className="team-link"
                    >
                      {entry.teamName}
                    </Link>
                  </td>
                  {entry.periods.map((p) => (
                    <td key={p.stage} className="num period-cell">
                      {p.xi.length > 0 ? (
                        <details className="xi-details">
                          <summary className="xi-summary">
                            {p.points}
                            <span className="xi-badge">
                              {p.formation}
                            </span>
                          </summary>
                          <div className="xi-popup">
                            <div className="xi-popup-header">
                              {STAGE_FULL[p.stage] ?? p.stage} &mdash;{" "}
                              {entry.teamName} &mdash; {p.formation}
                            </div>
                            <table className="xi-table">
                              <thead>
                                <tr>
                                  <th>Player</th>
                                  <th>Pos</th>
                                  <th className="num">Pts</th>
                                </tr>
                              </thead>
                              <tbody>
                                {[...p.xi]
                                  .sort(
                                    (a, b) =>
                                      b.points - a.points ||
                                      a.fullName.localeCompare(b.fullName),
                                  )
                                  .map((slot) => (
                                    <tr key={slot.playerId}>
                                      <td>{slot.fullName}</td>
                                      <td className="pos-badge">{slot.position}</td>
                                      <td className="num">{slot.points}</td>
                                    </tr>
                                  ))}
                              </tbody>
                            </table>
                          </div>
                        </details>
                      ) : (
                        <span className="muted-pts">{p.points}</span>
                      )}
                    </td>
                  ))}
                  <td className="num">{entry.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
