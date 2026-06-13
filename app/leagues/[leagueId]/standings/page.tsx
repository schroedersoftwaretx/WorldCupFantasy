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
import {
  cumulativeRanksThroughStage,
  getSnapshotRanks,
  managerOfStage,
  scoredStages,
  type ManagerOfStage,
} from "@/data/standings/snapshot";
import { getAliveCounts, type TeamAliveCount } from "@/web/alive";
import type { LeagueDetail } from "@/web/api-types";
import { getCurrentUser } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { getLeagueDetail, getMembershipRole } from "@/web/queries";
import {
  getProjectedStandings,
  type ProjectedStandingsEntry,
} from "@/web/standings-view";

import RecomputeButton from "./recompute-button";
import StandingsPeriodTable from "./standings-period-table";

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
  let projected: ProjectedStandingsEntry[] = [];
  let aliveStarted = false;
  let aliveByTeam = new Map<number, TeamAliveCount>();
  let prevRanks = new Map<number, number>();
  let hasMovement = false;
  let stageStar: ManagerOfStage | null = null;
  let error: string | null = null;
  try {
    const db = getDb();
    role = await getMembershipRole(db, id, user.manager.id);
    if (role) {
      detail = await getLeagueDetail(db, id);
      if (detail) {
        standings = await computeStandings(db, id);

        // B1: players-still-alive counts (hidden pre-tournament).
        const alive = await getAliveCounts(db, id);
        aliveStarted = alive.started;
        aliveByTeam = alive.byFantasyTeam;

        // B2: rank movement vs the end of the previous scored stage, from
        // the persisted snapshot (falling back to a live derivation when no
        // snapshot exists yet), plus Manager of the Stage.
        const stages = scoredStages(standings);
        if (stages.length >= 2) {
          const prev = stages[stages.length - 2];
          if (prev) {
            prevRanks = await getSnapshotRanks(db, id, prev);
            if (prevRanks.size === 0) {
              prevRanks = cumulativeRanksThroughStage(standings, prev);
            }
            hasMovement = prevRanks.size > 0;
          }
        }
        stageStar = managerOfStage(standings);

        // A3: projected leaderboard for the pre-tournament dead air.
        const allZero = standings.every((e) => e.total === 0);
        if (allZero && standings.length > 0) {
          projected = await getProjectedStandings(db, id);
        }
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

      {/* ---- B2: Manager of the Stage ---- */}
      {stageStar ? (
        <div className="stage-star">
          <span className="stage-star-badge">&#9733;</span> Manager of the
          Stage ({STAGE_FULL[stageStar.stage] ?? stageStar.stage}):{" "}
          <strong>
            {stageStar.fantasyTeamIds
              .map(
                (tid) =>
                  standings.find((e) => e.fantasyTeamId === tid)?.teamName ??
                  `team #${tid}`,
              )
              .join(", ")}
          </strong>{" "}
          with {stageStar.points} pts
        </div>
      ) : null}

      {/* ---- A3: projected leaderboard before any real points ---- */}
      {projected.length > 0 ? (
        <>
          <h2>
            Projected standings
            <span className="tag tag-projected">Projected</span>
          </h2>
          <p className="subtitle">
            No matches scored yet &mdash; this ranks each team&rsquo;s
            best-ball XI by PROJECTED points (and shows the expected number
            of its players on the title-winning squad). Real standings take
            over after the first match.
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Team</th>
                  <th>Manager</th>
                  <th className="num">Proj. XI pts</th>
                  <th className="num">Champ exposure</th>
                </tr>
              </thead>
              <tbody>
                {projected.map((e) => (
                  <tr key={e.fantasyTeamId}>
                    <td className="num">{e.rank}</td>
                    <td>
                      <Link
                        href={`/leagues/${id}/roster/${e.fantasyTeamId}`}
                        className="team-link"
                      >
                        {e.teamName}
                      </Link>
                    </td>
                    <td>
                      {nameByManager.get(e.managerId) ??
                        `manager #${e.managerId}`}
                    </td>
                    <td className="num">{e.projectedTotal}</td>
                    <td className="num">
                      {e.champExposure !== null ? e.champExposure : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {standings.length === 0 ? (
        <p className="notice">
          No teams in this league yet. Standings appear once managers join and
          draft their rosters.
        </p>
      ) : (
        <>
          {/* ---- Overall rankings table ---- */}
          <h2>Overall standings</h2>
          <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th className="num">#</th>
                {hasMovement ? <th className="num mv-col"></th> : null}
                <th>Team</th>
                <th>Manager</th>
                <th className="num">Total</th>
                {aliveStarted ? <th className="num">Alive</th> : null}
                <th className="num">Final pts</th>
                <th className="num">Goals</th>
                <th className="num">Assists</th>
              </tr>
            </thead>
            <tbody>
              {standings.map((entry) => {
                const prev = prevRanks.get(entry.fantasyTeamId);
                const delta = prev !== undefined ? prev - entry.rank : 0;
                const alive = aliveByTeam.get(entry.fantasyTeamId);
                const alivePct =
                  alive && alive.total > 0
                    ? Math.round((alive.alive / alive.total) * 100)
                    : 0;
                const aliveTone =
                  alivePct >= 60 ? "ok" : alivePct >= 30 ? "warn" : "bad";
                return (
                <tr key={entry.fantasyTeamId}>
                  <td className="num">{entry.rank}</td>
                  {hasMovement ? (
                    <td className="num mv-col">
                      {delta > 0 ? (
                        <span className="mv-up" title={`Up ${delta} from last stage`}>
                          &#9650;{delta}
                        </span>
                      ) : delta < 0 ? (
                        <span className="mv-down" title={`Down ${-delta} from last stage`}>
                          &#9660;{-delta}
                        </span>
                      ) : (
                        <span className="mv-flat">&ndash;</span>
                      )}
                    </td>
                  ) : null}
                  <td>
                    <Link
                      href={`/leagues/${id}/roster/${entry.fantasyTeamId}`}
                      className="team-link"
                    >
                      {entry.teamName}
                    </Link>
                    {stageStar &&
                    stageStar.fantasyTeamIds.includes(entry.fantasyTeamId) ? (
                      <span
                        className="stage-star-badge"
                        title="Manager of the Stage"
                      >
                        {" "}
                        &#9733;
                      </span>
                    ) : null}
                  </td>
                  <td>
                    {nameByManager.get(entry.managerId) ??
                      `manager #${entry.managerId}`}
                  </td>
                  <td className="num">{entry.total}</td>
                  {aliveStarted ? (
                    <td className="num alive-cell">
                      {alive ? (
                        <>
                          <span className={`alive-bar alive-${aliveTone}`}>
                            <span
                              className="alive-bar-fill"
                              style={{ width: `${alivePct}%` }}
                            />
                          </span>
                          {alive.alive}/{alive.total}
                        </>
                      ) : (
                        "-"
                      )}
                    </td>
                  ) : null}
                  <td className="num">{entry.tieBreakers.finalMatchPoints}</td>
                  <td className="num">{entry.tieBreakers.tournamentGoals}</td>
                  <td className="num">
                    {entry.tieBreakers.tournamentAssists}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
          </div>

          {/* ---- Per-period breakdown with XI overlay (client component) ---- */}
          <h2>Best-ball points by scoring period</h2>
          <p className="subtitle">
            Click a cell to reveal that team&rsquo;s best-ball XI for that
            period.
          </p>
          <StandingsPeriodTable
            leagueId={id}
            stages={allPeriods.map((p) => p.stage)}
            stageLabel={STAGE_LABEL}
            stageFull={STAGE_FULL}
            rows={standings.map((e) => ({
              fantasyTeamId: e.fantasyTeamId,
              teamName: e.teamName,
              periods: e.periods,
              total: e.total,
            }))}
          />
        </>
      )}
    </>
  );
}
