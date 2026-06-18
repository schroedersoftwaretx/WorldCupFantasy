/**
 * Pitch graphic + lineup helpers.
 *
 * Two public views share one SVG pitch (PitchSvg):
 *   - BestLineupViz: a single projected/best XI. Used in the draft room (by
 *     draft rank, pre-tournament) and anywhere a one-shot "best XI" is wanted.
 *   - The roster page's per-week pitch (see roster-pitch.tsx) renders PitchSvg
 *     directly from computePeriodLineup for the selected scoring period.
 *
 * Formation rules match the best-ball ruleset (1 GK + 10 outfield; DEF 4-5,
 * MID 2-4, FWD 2-3 -> 4-3-3 / 4-4-2 / 5-2-3 / 5-3-2). Each row is centred on
 * its real player count; empty slots render as dashed placeholders so a partial
 * or not-yet-played team still reads as a team.
 *
 * When rendered inside a <PlayerStatsProvider> (the roster page), clicking a
 * filled circle opens that player's score breakdown. Outside a provider
 * (the draft room) the circles are non-interactive.
 */
"use client";

import {
  optimizeBestBall,
  formationLabel,
  type ScoredPlayer,
} from "@/data/standings/lineup";
import type { Position } from "@/data/db/schema";

import { usePlayerStats } from "../player-stats-modal";

const PITCH_W = 300;
const PITCH_H = 440;
const PLAYER_R = 22;

export interface Player {
  playerId?: number;
  fullName: string;
  position: string;
  /** Lower is better; null or 0 = unranked. */
  draftRank?: number | null;
  /**
   * Total points the player scored (summed across scoring periods, or within
   * one period for the per-week pitch). When any roster player carries points,
   * the pitch shows the genuine best-ball OPTIMUM by points (the same optimizer
   * the standings use) instead of the draft-rank projection.
   */
  points?: number;
  /**
   * Whether the player has actually featured (has a result) in the period being
   * displayed. Drives the per-week pitch's "fills in gradually" behaviour: a
   * player is only placed on the pitch once they have appeared; everyone else
   * is an empty slot.
   */
  appeared?: boolean;
}

interface Slot {
  name: string | null; // null = empty placeholder
  playerId?: number | undefined;
}

export interface Lineup {
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

const PITCH_POSITIONS: readonly Position[] = ["GK", "DEF", "MID", "FWD"];
/** The skeleton shown before a legal XI can be fielded (4-3-3). */
const DEFAULT_SHELL = { DEF: 4, MID: 3, FWD: 3 } as const;

/**
 * Points-aware lineup: run the canonical best-ball optimizer over the given
 * players' points and render exactly the XI it selects. Returns null when they
 * cannot field a legal XI (e.g. an incomplete/partial roster), so the caller
 * can fall back to a projection or a default skeleton.
 */
function pointsLineup(
  roster: Player[],
): { lineup: Lineup; formation: string } | null {
  const eligible = roster.filter(
    (p) =>
      p.playerId !== undefined &&
      (PITCH_POSITIONS as readonly string[]).includes(p.position),
  );
  if (eligible.length === 0) return null;

  const scored: ScoredPlayer[] = eligible.map((p) => ({
    playerId: p.playerId as number,
    position: p.position as Position,
    points: p.points ?? 0,
  }));

  let best;
  try {
    best = optimizeBestBall(scored);
  } catch {
    return null; // too thin to field any legal XI
  }

  const playerById = new Map<number, Player>(
    eligible.map((p) => [p.playerId as number, p]),
  );
  const pickFor = (pos: Position): Player[] => {
    const out: Player[] = [];
    for (const s of best.xi) {
      if (s.position !== pos) continue;
      const pl = playerById.get(s.playerId);
      if (pl) out.push(pl);
    }
    return out;
  };

  const gkPlayers = pickFor("GK");
  const defPlayers = pickFor("DEF");
  const midPlayers = pickFor("MID");
  const fwdPlayers = pickFor("FWD");

  return {
    lineup: {
      gk: toSlots(gkPlayers, 1),
      def: toSlots(defPlayers, defPlayers.length || 4),
      mid: toSlots(midPlayers, midPlayers.length || 3),
      fwd: toSlots(fwdPlayers, fwdPlayers.length || 3),
    },
    formation: formationLabel(best.formation),
  };
}

/**
 * Per-period pitch: place only the players who have APPEARED (have a result)
 * in the period, so the XI fills in gradually as the week's matches are played.
 *
 *  - Once the appeared players can field a legal XI, show the genuine best-ball
 *    optimum (this re-optimises, and can change formation, as more scores land
 *    or are recalculated).
 *  - Before then, show a default 4-3-3 skeleton with the appeared players slotted
 *    by position (best first) and the remaining slots empty.
 */
export function computePeriodLineup(
  players: Player[],
): { lineup: Lineup; formation: string } {
  const appeared = players.filter(
    (p) =>
      p.appeared === true &&
      p.playerId !== undefined &&
      (PITCH_POSITIONS as readonly string[]).includes(p.position),
  );

  const optimum = pointsLineup(appeared);
  if (optimum) return optimum;

  const byPos: Record<Position, Player[]> = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const p of appeared) byPos[p.position as Position].push(p);
  const pointsOf = (p: Player): number => p.points ?? 0;
  for (const pos of PITCH_POSITIONS) {
    byPos[pos].sort(
      (a, b) => pointsOf(b) - pointsOf(a) || (a.playerId ?? 0) - (b.playerId ?? 0),
    );
  }

  return {
    lineup: {
      gk: toSlots(byPos.GK.slice(0, 1), 1),
      def: toSlots(byPos.DEF.slice(0, DEFAULT_SHELL.DEF), DEFAULT_SHELL.DEF),
      mid: toSlots(byPos.MID.slice(0, DEFAULT_SHELL.MID), DEFAULT_SHELL.MID),
      fwd: toSlots(byPos.FWD.slice(0, DEFAULT_SHELL.FWD), DEFAULT_SHELL.FWD),
    },
    formation: `${DEFAULT_SHELL.DEF}-${DEFAULT_SHELL.MID}-${DEFAULT_SHELL.FWD}`,
  };
}

export function computeLineup(roster: Player[]): { lineup: Lineup; formation: string } {
  // Points-aware path: once matches are scored the roster carries real points,
  // so show the genuine best-ball optimum (matches the standings) rather than
  // the draft-rank projection used pre-tournament / in the draft room.
  if (roster.some((p) => typeof p.points === "number")) {
    const pts = pointsLineup(roster);
    if (pts) return pts;
  }

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
      {clickable ? <title>{name} &mdash; view stats</title> : null}
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

/** The shared SVG pitch. Renders a given lineup; rows top-to-bottom FWD->GK. */
export function PitchSvg({
  lineup,
  formation,
}: {
  lineup: Lineup;
  formation: string;
}) {
  const { openStats } = usePlayerStats();

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
        aria-label={`Lineup: ${formation} formation`}
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

export function BestLineupViz({ roster }: { roster: Player[] }) {
  const { lineup, formation } = computeLineup(roster);
  return <PitchSvg lineup={lineup} formation={formation} />;
}
