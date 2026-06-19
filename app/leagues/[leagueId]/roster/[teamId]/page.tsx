/**
 * Roster view page (W5).
 *
 * Shows one fantasy team's full 23-player roster with per-period scoring
 * detail and best-ball XI indicators. The team must belong to the league;
 * the viewer must be a league member.
 *
 * The pitch graphic and every roster row are clickable: they open a modal
 * with that player's per-fixture score breakdown (PlayerStatsProvider).
 *
 * URL: /leagues/[leagueId]/roster/[teamId]
 */
import Link from "next/link";
import { RosterPitch } from "./roster-pitch";
import {
  PlayerStatsProvider,
  PlayerStatButton,
} from "../../player-stats-modal";
import { redirect } from "next/navigation";

import type { RosterViewData } from "@/web/api-types";
import { formatPoints } from "@/web/format";
import { getCurrentUser } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { getMembershipRole } from "@/web/queries";
import { getRosterScores } from "@/web/standings-view";
import { flagImg } from "@/web/flags";
import { HUB_RULESET_VERSION } from "@/web/stats-params";
import { teamInsights, type TeamInsights } from "@/data/stats/differentials";

import { DifferentialsPanel } from "./differentials-panel";
import { BestHaulBadge } from "./best-haul-badge";

export const dynamic = "force-dynamic";

/** Short column labels matching the standings page. */
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

export default async function RosterViewPage({
  params,
}: {
  params: Promise<{ leagueId: string; teamId: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { leagueId, teamId } = await params;
  const lgId = Number(leagueId);
  const tmId = Number(teamId);

  const validIds =
    Number.isInteger(lgId) &&
    lgId > 0 &&
    Number.isInteger(tmId) &&
    tmId > 0;

  const back = (
    <Link href={validIds ? `/leagues/${lgId}/standings` : "/"} className="back-link">
      &larr; {validIds ? "Back to standings" : "Your leagues"}
    </Link>
  );

  if (!validIds) {
    return (
      <>
        {back}
        <p className="error">Invalid league or team id.</p>
      </>
    );
  }

  let role: string | null = null;
  let data: RosterViewData | null = null;
  let insights: TeamInsights | null = null;
  let error: string | null = null;

  try {
    const db = getDb();
    role = await getMembershipRole(db, lgId, user.manager.id);
    if (role) {
      data = await getRosterScores(db, lgId, tmId);
      // Privacy: differentials are only ever shown for the viewer's OWN team.
      if (data.managerId === user.manager.id) {
        insights = await teamInsights(db, {
          leagueId: lgId,
          teamId: tmId,
          rulesetVersion: HUB_RULESET_VERSION,
        });
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : "could not load roster";
  }

  if (error) {
    return (
      <>
        {back}
        <p className="error">Could not load roster: {error}</p>
      </>
    );
  }
  if (!role || !data) {
    return (
      <>
        {back}
        <p className="notice">League not found, or you are not a member.</p>
      </>
    );
  }

  // Collect which stages have any scores.
  const activePeriods = (data.players[0]?.periods ?? []).map((p) => p.stage);

  // Group by position for display.
  const byPosition = new Map<string, typeof data.players>();
  for (const p of data.players) {
    const list = byPosition.get(p.position) ?? [];
    list.push(p);
    byPosition.set(p.position, list);
  }
  const positions = ["GK", "DEF", "MID", "FWD"].filter((pos) =>
    byPosition.has(pos),
  );

  return (
    <>
      {back}
      <h1>
        {data.teamName}
        <span className="tag">{formatPoints(data.total)} pts</span>
        {data.players.some((p) => p.eliminated) ? (
          <span className="tag tag-alive">
            {data.players.filter((p) => !p.eliminated).length}/
            {data.players.length} still in
          </span>
        ) : null}
      </h1>
      <p className="subtitle">
        Managed by {data.managerName} &mdash; best-ball total across all scoring
        periods. Highlighted rows are in the best-ball XI for that period.
        {data.players.some((p) => p.eliminated)
          ? " Struck-through players' national teams are out of the tournament."
          : ""}
      </p>
      <BestHaulBadge leagueId={lgId} teamId={tmId} />

      {data.players.length === 0 ? (
        <p className="notice">
          No players on this roster yet. Complete the draft first.
        </p>
      ) : (
        <PlayerStatsProvider leagueId={lgId}>
          <div className="lineup-roster-wrap">
<RosterPitch players={data.players} />
          </div>
          <div className="roster-legend">
            <span className="xi-dot in-xi-dot" /> In best-ball XI
            <span className="xi-dot bench-dot" /> Bench
            <span className="roster-legend-hint">
              &mdash; click a player for their score breakdown
            </span>
          </div>

          {positions.map((pos) => {
            const group = byPosition.get(pos) ?? [];
            return (
              <section key={pos}>
                <h2>{pos}</h2>
                <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Player</th>
                      <th>Country</th>
                      {activePeriods.map((stage) => (
                        <th key={stage} className="num">
                          {STAGE_LABEL[stage] ?? stage}
                        </th>
                      ))}
                      <th className="num">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.map((player) => (
                      <tr
                        key={player.playerId}
                        className={
                          [
                            player.periods.some((p) => p.inXi)
                              ? "row-has-xi"
                              : "",
                            player.eliminated ? "row-eliminated" : "",
                          ]
                            .filter(Boolean)
                            .join(" ") || undefined
                        }
                      >
                        <td className="player-name-cell">
                          <PlayerStatButton
                            playerId={player.playerId}
                            fullName={player.fullName}
                            className="player-stat-link"
                          />
                        </td>
                        <td className="muted-cell">
                          {(() => {
                            const f = flagImg(player.nationalTeam);
                            return f ? (
                              <img
                                className="flag"
                                src={f.src}
                                srcSet={f.srcSet}
                                width={20}
                                height={15}
                                alt=""
                                loading="lazy"
                              />
                            ) : null;
                          })()}
                          {player.nationalTeam}
                        </td>
                        {player.periods.map((p) => (
                          <td
                            key={p.stage}
                            className={[
                              "num",
                              p.inXi ? "cell-in-xi" : "cell-bench",
                            ].join(" ")}
                            title={p.inXi ? "In best-ball XI" : "Bench"}
                          >
                            {p.points > 0 || p.inXi ? formatPoints(p.points) : "-"}
                          </td>
                        ))}
                        <td className="num player-total">{player.totalPoints}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </section>
            );
          })}
          {insights ? <DifferentialsPanel insights={insights} /> : null}
        </PlayerStatsProvider>
      )}
    </>
  );
}
