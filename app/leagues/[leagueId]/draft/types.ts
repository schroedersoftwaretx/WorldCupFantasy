/**
 * Shared constants and small types for the draft room and its presentational
 * subcomponents. The stateful container (<DraftRoom>) and the pure panels under
 * ./components both import from here so the values stay in one place.
 */
import type { DraftBoardPlayer } from "@/web/api-types";

/** Poll interval (ms) used when the SSE stream drops and we fall back. */
export const POLL_MS = 5000;

/** Roster positions, in display order. */
export const POSITIONS = ["GK", "DEF", "MID", "FWD"] as const;

/** Max roster slots per position. */
export const POSITION_MAX: Record<(typeof POSITIONS)[number], number> = {
  GK: 4,
  DEF: 8,
  MID: 8,
  FWD: 8,
};

/** Under two minutes left counts as urgent (drives the timer's styling). */
export const URGENT_MS = 120_000;

/** A standard API response envelope. */
export interface Envelope {
  data?: unknown;
  error?: { message?: string };
}

/** Render a millisecond duration as a short countdown string. */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return "overdue";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * The single best still-available player per position, for the "best available"
 * hints. Driven primarily by Phase 2 ADP (lower = goes earlier = more coveted),
 * falling back to draft rank then projected points when ADP is absent.
 */
export function bestAvailableByPosition(
  players: DraftBoardPlayer[],
): { position: string; player: DraftBoardPlayer }[] {
  const order = ["GK", "DEF", "MID", "FWD"];
  const score = (p: DraftBoardPlayer): [number, number, number] => [
    p.adp ?? Number.POSITIVE_INFINITY,
    p.draftRank != null && p.draftRank > 0 ? p.draftRank : Number.POSITIVE_INFINITY,
    -(p.projectedTotalPoints ?? -1),
  ];
  const out: { position: string; player: DraftBoardPlayer }[] = [];
  for (const pos of order) {
    let best: DraftBoardPlayer | null = null;
    let bestScore: [number, number, number] | null = null;
    for (const p of players) {
      if (p.position !== pos) continue;
      const s = score(p);
      if (
        bestScore === null ||
        s[0] < bestScore[0] ||
        (s[0] === bestScore[0] && s[1] < bestScore[1]) ||
        (s[0] === bestScore[0] && s[1] === bestScore[1] && s[2] < bestScore[2])
      ) {
        best = p;
        bestScore = s;
      }
    }
    if (best) out.push({ position: pos, player: best });
  }
  return out;
}
