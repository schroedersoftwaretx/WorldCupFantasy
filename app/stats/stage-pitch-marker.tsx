/**
 * StagePitchMarker - a single, clickable pitch marker (client).
 *
 * Pulled out of StagePitch so the SVG circle/label can open the public player
 * stats modal via usePlayerStats(). When no PlayerStatsProvider is mounted the
 * opener is null and the marker renders as a plain (non-interactive) circle, so
 * the server-rendered pitch is always safe.
 */
"use client";

import type { TeamOfStagePlayer } from "@/data/stats/team-of-the-stage";

import { usePlayerStats } from "../leagues/[leagueId]/player-stats-modal";

const R = 24;

function surname(full: string): string {
  const parts = full.trim().split(/\s+/);
  const last = parts[parts.length - 1] ?? full;
  return last.length > 12 ? last.slice(0, 11) + "…" : last;
}

export function StagePitchMarker({
  x,
  y,
  p,
}: {
  x: number;
  y: number;
  p: TeamOfStagePlayer;
}) {
  const { openStats } = usePlayerStats();
  const open = openStats ? () => openStats(p.playerId, p.fullName) : undefined;

  return (
    <g
      className={open ? "pitch-player pitch-player-click" : "pitch-player"}
      role={open ? "button" : undefined}
      tabIndex={open ? 0 : undefined}
      style={open ? { cursor: "pointer" } : undefined}
      onClick={open}
      onKeyDown={
        open
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                open();
              }
            }
          : undefined
      }
    >
      <title>
        {p.fullName} ({p.nationalTeamName}) &mdash; {p.points} pts
      </title>
      <circle cx={x} cy={y} r={R} fill="rgba(255,255,255,0.92)" />
      <text
        x={x}
        y={y - 1}
        textAnchor="middle"
        fontSize="8"
        fontFamily="system-ui,sans-serif"
        fontWeight="700"
        fill="#15401f"
      >
        {surname(p.fullName)}
      </text>
      <text
        x={x}
        y={y + 9}
        textAnchor="middle"
        fontSize="7"
        fontFamily="system-ui,sans-serif"
        fill="#2d7a3a"
      >
        {p.points}
      </text>
    </g>
  );
}
