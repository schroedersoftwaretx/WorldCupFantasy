/**
 * StagePitch — a self-contained SVG pitch rendering the Team of the Stage XI.
 *
 * Unlike the draft's BestLineupViz this is a pure server component (no client
 * hooks / no stats-modal provider): it just lays the supplied XI out by
 * position, since the optimizer has already chosen the formation. Each marker
 * shows the player's surname, nation, and points.
 */
import type { TeamOfStagePlayer } from "@/data/stats/team-of-the-stage";

import { StagePitchMarker } from "./stage-pitch-marker";

const PITCH_W = 320;
const PITCH_H = 460;

type Pos = "GK" | "DEF" | "MID" | "FWD";

/** Evenly spaced, centred x-positions for `count` markers. */
function rowX(count: number): number[] {
  const margin = 34;
  const usable = PITCH_W - margin * 2;
  if (count <= 1) return [PITCH_W / 2];
  const gap = Math.min(usable / (count - 1), usable / 4);
  const start = (PITCH_W - gap * (count - 1)) / 2;
  return Array.from({ length: count }, (_, i) => start + i * gap);
}

export function StagePitch({
  xi,
  formation,
}: {
  xi: TeamOfStagePlayer[];
  formation: string | null;
}) {
  const byPos: Record<Pos, TeamOfStagePlayer[]> = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const p of xi) byPos[p.position].push(p);

  const rows: { players: TeamOfStagePlayer[]; y: number }[] = [
    { players: byPos.FWD, y: 80 },
    { players: byPos.MID, y: 190 },
    { players: byPos.DEF, y: 310 },
    { players: byPos.GK, y: 410 },
  ];

  return (
    <div className="lineup-viz">
      {formation ? <div className="lineup-label">{formation}</div> : null}
      <svg
        viewBox={`0 0 ${PITCH_W} ${PITCH_H}`}
        className="pitch-svg"
        aria-label={`Team of the Stage${formation ? `: ${formation}` : ""}`}
      >
        <rect width={PITCH_W} height={PITCH_H} rx={6} fill="#2d7a3a" />
        {Array.from({ length: 6 }, (_, i) => (
          <rect
            key={i}
            x={0}
            y={i * 77}
            width={PITCH_W}
            height={38}
            fill="rgba(0,0,0,0.06)"
          />
        ))}
        <rect
          x={14}
          y={14}
          width={PITCH_W - 28}
          height={PITCH_H - 28}
          rx={3}
          fill="none"
          stroke="rgba(255,255,255,0.35)"
          strokeWidth={1.5}
        />
        <line
          x1={14}
          y1={PITCH_H / 2}
          x2={PITCH_W - 14}
          y2={PITCH_H / 2}
          stroke="rgba(255,255,255,0.3)"
          strokeWidth={1}
        />
        <circle
          cx={PITCH_W / 2}
          cy={PITCH_H / 2}
          r={34}
          fill="none"
          stroke="rgba(255,255,255,0.3)"
          strokeWidth={1}
        />
        {rows.flatMap(({ players, y }) =>
          rowX(players.length).map((x, i) => {
            const p = players[i];
            return p ? (
              <StagePitchMarker key={`${y}-${i}`} x={x} y={y} p={p} />
            ) : null;
          }),
        )}
      </svg>
    </div>
  );
}
