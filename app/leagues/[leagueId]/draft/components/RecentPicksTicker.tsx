/**
 * The horizontal "Recent:" ticker shown above the board while the draft is in
 * progress. Shows the last 8 picks, most-recent first.
 */
"use client";

import type { DraftPickLog } from "@/web/api-types";

interface RecentPicksTickerProps {
  picks: DraftPickLog[];
}

export default function RecentPicksTicker({ picks }: RecentPicksTickerProps) {
  return (
    <div className="picks-ticker" aria-label="Recent picks" aria-live="polite">
      <span className="picks-ticker-label">Recent:</span>
      {picks.length === 0 ? (
        <span className="field-hint">no picks yet</span>
      ) : (
        [...picks]
          .reverse()
          .slice(0, 8)
          .map((p) => (
            <span key={p.pickNumber} className="ticker-pick">
              <span className="field-hint">#{p.pickNumber}</span>{" "}
              <span className="pos-badge">{p.position}</span> {p.playerName}{" "}
              <span className="field-hint">
                &rarr; {p.teamName}
                {p.isAutopick ? " (auto)" : ""}
              </span>
            </span>
          ))
      )}
    </div>
  );
}
