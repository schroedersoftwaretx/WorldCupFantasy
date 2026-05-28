/**
 * Roster view page (W5).
 *
 * Shows one fantasy team's full 23-player roster with per-period scoring
 * detail and best-ball XI indicators. The team must belong to the league;
 * the viewer must be a league member.
 *
 * URL: /leagues/[leagueId]/roster/[teamId]
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import type { RosterViewData } from "@/web/api-types";
import { getCurrentUser } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { getMembershipRole } from "@/web/queries";
import { getRosterScores } from "@/web/standings-view";

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

const POSITION_ORDER: Record<string, number> = {
  GK: 0,
  DEF: 1,
  MID: 2,
  FWD: 3,
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
  let error: string | null = null;

  try {
    const db = getDb();
    role = await getMembershipRole(db, lgId, user.manager.id);
    if (role) {
      data = await getRosterScores(db, lgId, tmId);
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
        <span className="tag">{data.total} pts</span>
      </h1>
      <p className="subtitle">
        Managed by {data.managerName} &mdash; best-ball total across all scoring
        periods. Highlighted rows are in the best-ball XI for that period.
      </p>

      {data.players.length === 0 ? (
        <p className="notice">
          No players on this roster yet. Complete the draft first.
        </p>
      ) : (
        <>
          <div className="roster-legend">
            <span className="xi-dot in-xi-dot" /> In best-ball XI
            <span className="xi-dot bench-dot" /> Bench
          </div>

          {positions.map((pos) => {
            const group = byPosition.get(pos) ?? [];
            return (
              <section key={pos}>
                <h2>{pos}</h2>
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
                          player.periods.some((p) => p.inXi)
                            ? "row-has-xi"
                            : undefined
                        }
                      >
                        <td>{player.fullName}</td>
                        <td className="muted-cell">{player.nationalTeam}</td>
                        {player.periods.map((p) => (
                          <td
                            key={p.stage}
                            className={[
                              "num",
                              p.inXi ? "cell-in-xi" : "cell-bench",
                            ].join(" ")}
                            title={p.inXi ? "In best-ball XI" : "Bench"}
                          >
                            {p.points > 0 || p.inXi ? p.points : "-"}
                          </td>
                        ))}
                        <td className="num player-total">{player.totalPoints}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            );
          })}
        </>
      )}
    </>
  );
}
