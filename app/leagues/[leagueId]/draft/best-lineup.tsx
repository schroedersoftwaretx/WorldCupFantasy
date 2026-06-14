/**
 * BestLineupViz — SVG pitch graphic showing the viewer's current best lineup.
 *
 * Formation rules (matching the best-ball ruleset):
 *   Base:       1 GK + 4 DEF + 2 MID + 2 FWD  (9 players)
 *   FLEX_DM:    +1 DEF (→5-back) or +1 MID
 *   FLEX_MF:    +1 MID or +1 FWD
 *   Display default (empty team): 4-3-3
 *
 * Each row is centred to its actual player count, so e.g. a 5-3-2 shows two
 * central strikers rather than two forwards spread across a 3-wide row.
 * A row with no players falls back to the 4/3/3 placeholder shape (dashed
 * circles) so an empty/partial team still reads as a team.
 *
 * When rendered inside a <PlayerStatsProvider> (the roster page), clicking a
 * filled circle opens that player's score breakdown. Outside a provider
 * (the draft room) the circles are non-interactive.
 */
"use client";

import { usePlayerStats } from "../player-stats-modal";

const PITCH_W = 300;
const PITCH_H = 440;
const PLAYER_R = 22;

interface Player {
  playerId?: number;
  fullName: string;
  position: string;
  /** Lower is better; null or 0 = unranked. */
  draftRank?: number | null;
}

interface Slot {
  name: string | null; // null = empty placeholder
  playerId?: number | undefined;
}

interface Lineup {
  gk: Slot[];
  def: Slot[];
  mid: Slot[];
  fwd: Slot[];
}

/** Last word of a name, truncated to 11 chars. */
function abbrev(full: string): string {
  const parts = full.trim().split(/\s+/);
  const last = parts[parts.length - 1] ?? full;
  return last.length > 11 ? last.slice(0, 10) + "." : last;
}

function toSlots(players: Player[], total: number): Slot[] {
  const filled: Slot[] = players.map((p) => ({
    name: p.fullName,
    playerId: p.playerId,
  }));
  const empty: Slot[] = Array.from(
    { length: Math.max(0, total - players.length) },
    () => ({ name: null }),
  );
  return [...filled, ...empty];
}

function computeLineup(roster: Player[]): { lineup: Lineup; formation: string } {
  const byPos: { GK: Player[]; DEF: Player[]; MID: Player[]; FWD: Player[] } = { GK: [], DEF: [], MID: [], FWD: [] };
  /** Effective sort rank: unranked (null/0) goes to the end. */
  const rankOf = (p: Player): number =>
    p.draftRank != null && p.draftRank > 0 ? p.draftRank : Number.MAX_SAFE_INTEGER;

  for (const p of roster) {
    const key = p.position as keyof typeof byPos;
    if (key in byPos) byPos[key].push(p);
  }
  // Sort each pool by rank so slice(0,n) gives the best n players.
  for (const pool of Object.values(byPos)) {
    pool.sort((a, b) => rankOf(a) - rankOf(b));
  }

  // Base allocation (Player objects)
  const gkPlayers = byPos.GK.slice(0, 1);
  let defPlayers = byPos.DEF.slice(0, 4);
  let midPlayers = byPos.MID.slice(0, 2);
  let fwdPlayers = byPos.FWD.slice(0, 2);

  // FLEX_DM: compare rank of next DEF vs next MID; pick higher ranked.
  const xDef = byPos.DEF[4];
  const xMid1 = byPos.MID[2];
  if (xDef !== undefined && xMid1 !== undefined) {
    if (rankOf(xDef) <= rankOf(xMid1)) {
      defPlayers = [...defPlayers, xDef];
    } else {
      midPlayers = [...midPlayers, xMid1];
    }
  } else if (xDef !== undefined) {
    defPlayers = [...defPlayers, xDef];
  } else if (xMid1 !== undefined) {
    midPlayers = [...midPlayers, xMid1];
  }

  // FLEX_MF: compare rank of next MID vs next FWD; pick higher ranked.
  const xMid2 = byPos.MID[midPlayers.length];
  const xFwd = byPos.FWD[2];
  if (xMid2 !== undefined && xFwd !== undefined && midPlayers.length < 4) {
    if (rankOf(xMid2) <= rankOf(xFwd)) {
      midPlayers = [...midPlayers, xMid2];
    } else {
      fwdPlayers = [...fwdPlayers, xFwd];
    }
  } else if (xMid2 !== undefined && midPlayers.length < 4) {
    midPlayers = [...midPlayers, xMid2];
  } else if (xFwd !== undefined) {
    fwdPlayers = [...fwdPlayers, xFwd];
  }

  // Displayed slot counts: centre each row on its real count; only fall back
  // to the 4/3/3 placeholder shape when a row is entirely empty.
  const defShow = defPlayers.length || 4;
  const midShow = midPlayers.length || 3;
  const fwdShow = fwdPlayers.length || 3;

  const formation = `${defPlayers.length || 4}-${midPlayers.length || 3}-${fwdPlayers.length || 3}`;

  return {
    lineup: {
      gk:  toSlots(gkPlayers,  1),
      def: toSlots(defPlayers, defShow),
      mid: toSlots(midPlayers, midShow),
      fwd: toSlots(fwdPlayers, fwdShow),
    },
    formation,
  };
}

/**
 * X-positions for `count` players in a row, centred on the pitch with a
 * consistent gap. A full 5-wide row spans the whole width; rows with fewer
 * players (e.g. two strikers) are a centred cluster rather than being pushed
 * out to the touchlines.
 */
function rowX(count: number): number[] {
  const margin = 30;
  const usable = PITCH_W - margin * 2;
  if (count <= 1) return [PITCH_W / 2];
  // Cap the gap at the 5-across spacing so smaller rows stay central.
  const gap = Math.min(usable / (count - 1), usable / 4);
  const start = (PITCH_W - gap * (count - 1)) / 2;
  return Array.from({ length: count }, (_, i) => start + i * gap);
}

function PlayerCircle({
  x,
  y,
  name,
  onClick,
}: {
  x: number;
  y: number;
  name: string | null;
  onClick?: (() => void) | undefined;
}) {
  const empty = name === null;
  const clickable = !empty && onClick !== undefined;
  return (
    <g
      onClick={clickable ? onClick : undefined}
      style={clickable ? { cursor: "pointer" } : undefined}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      className={clickable ? "pitch-player clickable" : "pitch-player"}
    >
      {clickable ? <title>{name} — view stats</title> : null}
      <circle
        cx={x} cy={y} r={PLAYER_R}
        fill={empty ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.88)"}
        stroke="rgba(255,255,255,0.5)"
        strokeWidth={empty ? 1.5 : 0}
        strokeDasharray={empty ? "4 2" : undefined}
      />
      <text
        x={x} y={y + 4}
        textAnchor="middle"
        fontSize="7.5"
        fontFamily="system-ui,sans-serif"
        fontWeight="700"
        fill={empty ? "rgba(255,255,255,0.35)" : "#1a4a28"}
      >
        {name !== null ? abbrev(name) : "?"}
      </text>
    </g>
  );
}

export function BestLineupViz({ roster }: { roster: Player[] }) {
  const { openStats } = usePlayerStats();
  const { lineup, formation } = computeLineup(roster);

  const rows: { slots: Slot[]; y: number }[] = [
    { slots: lineup.fwd, y: 78 },
    { slots: lineup.mid, y: 188 },
    { slots: lineup.def, y: 302 },
    { slots: lineup.gk,  y: 395 },
  ];

  return (
    <div className="lineup-viz">
      <div className="lineup-label">{formation}</div>
      <svg
        viewBox={`0 0 ${PITCH_W} ${PITCH_H}`}
        className="pitch-svg"
        aria-label={`Best lineup: ${formation} formation`}
      >
        {/* Pitch surface */}
        <rect width={PITCH_W} height={PITCH_H} rx={6} fill="#2d7a3a" />
        {/* Stripe bands for grass effect */}
        {Array.from({ length: 6 }, (_, i) => (
          <rect key={i} x={0} y={i * 74} width={PITCH_W} height={37}
            fill="rgba(0,0,0,0.06)" />
        ))}
        {/* Pitch border */}
        <rect x={14} y={14} width={PITCH_W - 28} height={PITCH_H - 28}
          rx={3} fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth={1.5} />
        {/* Halfway line */}
        <line x1={14} y1={PITCH_H / 2} x2={PITCH_W - 14} y2={PITCH_H / 2}
          stroke="rgba(255,255,255,0.3)" strokeWidth={1} />
        {/* Center circle */}
        <circle cx={PITCH_W / 2} cy={PITCH_H / 2} r={34}
          fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth={1} />
        <circle cx={PITCH_W / 2} cy={PITCH_H / 2} r={3}
          fill="rgba(255,255,255,0.3)" />
        {/* Top penalty area */}
        <rect x={72} y={14} width={156} height={56}
          fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth={1} />
        {/* Bottom penalty area */}
        <rect x={72} y={PITCH_H - 70} width={156} height={56}
          fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth={1} />

        {/* Players */}
        {rows.flatMap(({ slots, y }) =>
          rowX(slots.length).map((x, i) => {
            const slot = slots[i];
            const pid = slot?.playerId;
            const handler =
              pid !== undefined && openStats !== null && slot?.name
                ? () => openStats(pid, slot.name as string)
                : undefined;
            return (
              <PlayerCircle
                key={`${y}-${i}`}
                x={x}
                y={y}
                name={slot?.name ?? null}
                onClick={handler}
              />
            );
          }),
        )}
      </svg>
    </div>
  );
}
