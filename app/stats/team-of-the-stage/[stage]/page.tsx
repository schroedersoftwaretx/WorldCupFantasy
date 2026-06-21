/**
 * Public Team of the Stage page: the best legal XI from the whole tournament's
 * player pool for one scoring period, as a pitch + a detail table. No login.
 */
import Link from "next/link";

import { stagesWithScores } from "@/data/stats/aggregate";
import {
  teamOfTheStage,
  teamOfTheTournament,
} from "@/data/stats/team-of-the-stage";
import type {
  TeamOfStage,
  TeamOfTournament,
} from "@/data/stats/team-of-the-stage";
import type { Stage } from "@/data/db/schema";
import { getDb } from "@/web/db";
import { HUB_RULESET_VERSION, isStage } from "@/web/stats-params";

import { STAGE_FULL } from "../../stage-labels";
import { StageNav } from "../../stage-nav";
import { StagePitch } from "../../stage-pitch";
import {
  PlayerStatsProvider,
  PlayerStatButton,
} from "../../../leagues/[leagueId]/player-stats-modal";

export const dynamic = "force-dynamic";

export default async function TeamOfStagePage({
  params,
}: {
  params: Promise<{ stage: string }>;
}) {
  const { stage } = await params;
  const back = (
    <Link href="/stats" className="back-link">
      &larr; Stats Hub
    </Link>
  );

  const isAll = stage === "all";

  if (!isAll && !isStage(stage)) {
    return (
      <>
        {back}
        <p className="error">Unknown stage: {stage}</p>
      </>
    );
  }
  const s: Stage | null = isAll ? null : (stage as Stage);

  let team: TeamOfStage | TeamOfTournament | null = null;
  let scored: Stage[] = [];
  let error: string | null = null;
  try {
    const db = getDb();
    scored = await stagesWithScores(db, HUB_RULESET_VERSION);
    team = isAll
      ? await teamOfTheTournament(db, { rulesetVersion: HUB_RULESET_VERSION })
      : await teamOfTheStage(db, {
          rulesetVersion: HUB_RULESET_VERSION,
          stage: s as Stage,
        });
  } catch (e) {
    error = e instanceof Error ? e.message : "could not load the team of the stage";
  }

  return (
    <>
      {back}
      <h1>{isAll ? "Team of the Tournament" : "Team of the Stage"}</h1>
      <p className="subtitle">
        {isAll ? "Best XI across the whole tournament" : STAGE_FULL[s as Stage]}
      </p>
      <StageNav current={s} scored={scored} all={isAll} />

      {error ? (
        <p className="error">Could not load: {error}</p>
      ) : !team || team.xi.length === 0 ? (
        <p className="notice">
          {isAll
            ? "No scored matches yet. The best XI appears once results are in."
            : "No scored matches for this stage yet. The best XI appears once results are in."}
        </p>
      ) : (
        <PlayerStatsProvider>
        <div className="tos-layout">
          <StagePitch xi={team.xi} formation={team.formation} />
          <div className="tos-detail">
            <p className="tos-total">
              Formation <strong>{team.formation}</strong> &middot;{" "}
              <strong>{team.points}</strong> pts
            </p>
            <div className="table-scroll" tabIndex={0} role="region" aria-label="Scrollable table (use arrow keys)">
              <table>
                <thead>
                  <tr>
                    <th>Pos</th>
                    <th>Player</th>
                    <th>Nation</th>
                    <th className="num">Pts</th>
                    <th className="num">G</th>
                    <th className="num">A</th>
                    <th className="num">Sv</th>
                    <th className="num">Min</th>
                  </tr>
                </thead>
                <tbody>
                  {team.xi.map((p) => (
                    <tr key={p.playerId}>
                      <td>{p.position}</td>
                      <td>
                        <PlayerStatButton
                          playerId={p.playerId}
                          fullName={p.fullName}
                        />
                      </td>
                      <td>{p.nationalTeamName}</td>
                      <td className="num">{p.points}</td>
                      <td className="num">{p.goals}</td>
                      <td className="num">{p.assists}</td>
                      <td className="num">{p.saves}</td>
                      <td className="num">{p.minutesPlayed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        </PlayerStatsProvider>
      )}
    </>
  );
}
