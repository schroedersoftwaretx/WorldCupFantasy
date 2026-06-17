/**
 * Public Team of the Stage page: the best legal XI from the whole tournament's
 * player pool for one scoring period, as a pitch + a detail table. No login.
 */
import Link from "next/link";

import { stagesWithScores } from "@/data/stats/aggregate";
import { teamOfTheStage } from "@/data/stats/team-of-the-stage";
import type { TeamOfStage } from "@/data/stats/team-of-the-stage";
import type { Stage } from "@/data/db/schema";
import { getDb } from "@/web/db";
import { HUB_RULESET_VERSION, isStage } from "@/web/stats-params";

import { STAGE_FULL } from "../../stage-labels";
import { StageNav } from "../../stage-nav";
import { StagePitch } from "../../stage-pitch";

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

  if (!isStage(stage)) {
    return (
      <>
        {back}
        <p className="error">Unknown stage: {stage}</p>
      </>
    );
  }
  const s: Stage = stage;

  let team: TeamOfStage | null = null;
  let scored: Stage[] = [];
  let error: string | null = null;
  try {
    const db = getDb();
    scored = await stagesWithScores(db, HUB_RULESET_VERSION);
    team = await teamOfTheStage(db, { rulesetVersion: HUB_RULESET_VERSION, stage: s });
  } catch (e) {
    error = e instanceof Error ? e.message : "could not load the team of the stage";
  }

  return (
    <>
      {back}
      <h1>Team of the Stage</h1>
      <p className="subtitle">{STAGE_FULL[s]}</p>
      <StageNav current={s} scored={scored} />

      {error ? (
        <p className="error">Could not load: {error}</p>
      ) : !team || team.xi.length === 0 ? (
        <p className="notice">
          No scored matches for this stage yet. The best XI appears once results
          are in.
        </p>
      ) : (
        <div className="tos-layout">
          <StagePitch xi={team.xi} formation={team.formation} />
          <div className="tos-detail">
            <p className="tos-total">
              Formation <strong>{team.formation}</strong> &middot;{" "}
              <strong>{team.points}</strong> pts
            </p>
            <div className="table-scroll">
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
                      <td>{p.fullName}</td>
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
      )}
    </>
  );
}
