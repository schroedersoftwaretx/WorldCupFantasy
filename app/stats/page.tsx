/**
 * Stats Hub landing (Phase 1) — PUBLIC, tournament-wide.
 *
 * Not league-specific and not login-gated: any visitor sees the headline Team
 * of the Stage for the latest scored period plus entry points into the
 * leaderboards and records. The `stats_hub` feature flag only governs whether a
 * league's own nav links here; it does NOT gate this page.
 */
import Link from "next/link";

import { latestStageWithScores, stagesWithScores } from "@/data/stats/aggregate";
import { teamOfTheStage } from "@/data/stats/team-of-the-stage";
import type { TeamOfStage } from "@/data/stats/team-of-the-stage";
import type { Stage } from "@/data/db/schema";
import { getDb } from "@/web/db";
import { HUB_RULESET_VERSION } from "@/web/stats-params";

import { STAGE_FULL } from "./stage-labels";
import { StageNav } from "./stage-nav";
import { StagePitch } from "./stage-pitch";
import {
  PlayerStatsProvider,
  PlayerStatButton,
} from "../leagues/[leagueId]/player-stats-modal";

export const dynamic = "force-dynamic";

export default async function StatsPage() {
  let latest: Stage | null = null;
  let scored: Stage[] = [];
  let team: TeamOfStage | null = null;
  let error: string | null = null;
  try {
    const db = getDb();
    scored = await stagesWithScores(db, HUB_RULESET_VERSION);
    latest = await latestStageWithScores(db, HUB_RULESET_VERSION);
    if (latest) {
      team = await teamOfTheStage(db, {
        rulesetVersion: HUB_RULESET_VERSION,
        stage: latest,
      });
    }
  } catch (e) {
    error = e instanceof Error ? e.message : "could not load stats";
  }

  return (
    <>
      <h1>Tournament Stats Hub</h1>
      <p className="subtitle">
        Cross-tournament stats for everyone &mdash; no league required. The Team
        of the Stage is the best legal XI from every player in the tournament.
      </p>

      <nav className="hub-links">
        <Link href="/stats/leaderboards" className="hub-link">
          Leaderboards
        </Link>
        <Link href="/stats/players" className="hub-link">
          Player Explorer
        </Link>
        <Link href="/stats/records" className="hub-link">
          Records &amp; fun stats
        </Link>
        <Link href="/stats/draft-trends" className="hub-link">
          Draft Trends
        </Link>
        <Link href="/stats/awards" className="hub-link">
          Awards
        </Link>
        {latest ? (
          <Link
            href={`/stats/team-of-the-stage/${latest}`}
            className="hub-link"
          >
            Team of the Stage
          </Link>
        ) : null}
      </nav>

      {error ? (
        <p className="error">Could not load stats: {error}</p>
      ) : !latest || !team || team.xi.length === 0 ? (
        <p className="notice">
          No matches have been scored yet. The Stats Hub fills in once results
          start arriving.
        </p>
      ) : (
        <>
          <h2>Team of the Stage &mdash; {STAGE_FULL[latest]}</h2>
          <StageNav current={latest} scored={scored} />
          <PlayerStatsProvider>
          <div className="tos-layout">
            <StagePitch xi={team.xi} formation={team.formation} />
            <div className="tos-detail">
              <p className="tos-total">
                Formation <strong>{team.formation}</strong> &middot;{" "}
                <strong>{team.points}</strong> pts
              </p>
              <ul className="tos-list">
                {team.xi.map((p) => (
                  <li key={p.playerId}>
                    <span className="tos-pos">{p.position}</span>{" "}
                    <PlayerStatButton
                      playerId={p.playerId}
                      fullName={p.fullName}
                    />{" "}
                    <span className="muted">({p.nationalTeamName})</span>
                    <span className="num tos-pts">{p.points}</span>
                  </li>
                ))}
              </ul>
              <p>
                <Link href={`/stats/team-of-the-stage/${latest}`}>
                  Full pitch view &rarr;
                </Link>
              </p>
            </div>
          </div>
          </PlayerStatsProvider>
        </>
      )}
    </>
  );
}
