/**
 * The top draft banner: while in progress it shows the current pick, who is on
 * the clock, and a live countdown timer; once complete it shows the done state
 * with links to results and standings.
 */
"use client";

import { URGENT_MS, formatRemaining } from "../types";

interface OnClockBannerProps {
  inProgress: boolean;
  isOnClock: boolean;
  currentPickNumber: number | null;
  currentRound: number | null;
  picksMade: number;
  totalPicks: number;
  onClockTeamName: string | undefined;
  /** Milliseconds until the current pick deadline, or null when none. */
  remaining: number | null;
  leagueId: number;
}

export default function OnClockBanner({
  inProgress,
  isOnClock,
  currentPickNumber,
  currentRound,
  picksMade,
  totalPicks,
  onClockTeamName,
  remaining,
  leagueId,
}: OnClockBannerProps) {
  if (!inProgress) {
    return (
      <div className="draft-banner done">
        <strong>Draft complete</strong> &mdash; all {totalPicks} picks
        are in.{" "}
        <a href={`/leagues/${leagueId}/draft/results`}>
          View draft results &rarr;
        </a>{" "}
        &middot;{" "}
        <a href={`/leagues/${leagueId}/standings`}>View standings &rarr;</a>
      </div>
    );
  }
  return (
    <div className={isOnClock ? "draft-banner you" : "draft-banner"}>
      <div>
        <strong>Pick #{currentPickNumber}</strong> &middot; Round{" "}
        {currentRound} &middot; {picksMade}/{totalPicks}{" "}
        made
      </div>
      <div className="draft-banner-clock">
        <span>
          {isOnClock
            ? "You are on the clock"
            : `On the clock: ${onClockTeamName ?? "-"}`}
        </span>
        {remaining !== null ? (
          <span
            role="timer"
            aria-live={
              remaining <= URGENT_MS && remaining > 0 ? "assertive" : "polite"
            }
            aria-label={
              remaining <= 0
                ? "Pick is overdue"
                : `Time remaining: ${formatRemaining(remaining)}`
            }
            className={
              remaining <= 0
                ? "draft-timer overdue"
                : remaining <= URGENT_MS
                  ? "draft-timer urgent"
                  : "draft-timer"
            }
          >
            {remaining <= 0 ? "overdue" : formatRemaining(remaining)}
          </span>
        ) : null}
      </div>
    </div>
  );
}
