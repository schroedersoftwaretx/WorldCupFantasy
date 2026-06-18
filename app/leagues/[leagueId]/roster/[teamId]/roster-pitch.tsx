/**
 * RosterPitch (client) — the per-week pitch on the roster page.
 *
 * Shows the best-ball XI for ONE scoring period at a time on the SVG pitch.
 * Within the selected period the XI fills in gradually as that week's matches
 * are played (only players who have featured are placed; the rest are empty
 * slots), and the formation re-optimises as scores arrive or are recalculated.
 * A week selector lets the manager flip back to prior periods' lineups.
 */
"use client";

import { useMemo, useState } from "react";

import type { RosterPlayerScore } from "@/web/api-types";

import {
  PitchSvg,
  computePeriodLineup,
  type Player,
} from "../../draft/best-lineup";

/** The nine scoring periods, in tournament order. */
const STAGE_ORDER: readonly string[] = [
  "GROUP_1",
  "GROUP_2",
  "GROUP_3",
  "R32",
  "R16",
  "QF",
  "SF",
  "THIRD_PLACE",
  "FINAL",
];

const STAGE_LABEL: Record<string, string> = {
  GROUP_1: "MD1",
  GROUP_2: "MD2",
  GROUP_3: "MD3",
  R32: "R32",
  R16: "R16",
  QF: "QF",
  SF: "SF",
  THIRD_PLACE: "3rd",
  FINAL: "Final",
};

const STAGE_FULL: Record<string, string> = {
  GROUP_1: "Group Stage — Matchday 1",
  GROUP_2: "Group Stage — Matchday 2",
  GROUP_3: "Group Stage — Matchday 3",
  R32: "Round of 32",
  R16: "Round of 16",
  QF: "Quarter-finals",
  SF: "Semi-finals",
  THIRD_PLACE: "Third-place playoff",
  FINAL: "Final",
};

export function RosterPitch({ players }: { players: RosterPlayerScore[] }) {
  // The weeks that have any result yet: these are the periods you can review.
  const playedStages = useMemo(() => {
    const set = new Set<string>();
    for (const p of players) {
      for (const pd of p.periods) if (pd.appeared) set.add(pd.stage);
    }
    return STAGE_ORDER.filter((s) => set.has(s));
  }, [players]);

  const [stage, setStage] = useState<string | null>(null);
  // Default to the most recent played week; before any results, the first
  // period (shown as an empty default skeleton).
  const selected =
    stage && playedStages.includes(stage)
      ? stage
      : (playedStages[playedStages.length - 1] ?? STAGE_ORDER[0] ?? "GROUP_1");

  const periodPlayers: Player[] = useMemo(
    () =>
      players.map((p) => {
        const pd = p.periods.find((x) => x.stage === selected);
        return {
          playerId: p.playerId,
          fullName: p.fullName,
          position: p.position,
          points: pd?.points ?? 0,
          appeared: pd?.appeared ?? false,
        };
      }),
    [players, selected],
  );

  const { lineup, formation } = useMemo(
    () => computePeriodLineup(periodPlayers),
    [periodPlayers],
  );

  return (
    <div className="roster-pitch">
      {playedStages.length > 0 ? (
        <nav className="stage-nav" aria-label="Scoring week">
          {playedStages.map((s) => (
            <button
              key={s}
              type="button"
              className={`stage-chip${s === selected ? " stage-chip-active" : ""}`}
              aria-pressed={s === selected}
              onClick={() => setStage(s)}
            >
              {STAGE_LABEL[s] ?? s}
            </button>
          ))}
        </nav>
      ) : (
        <p className="field-hint">
          No matches scored yet &mdash; your XI fills in here as each week&apos;s
          games are played.
        </p>
      )}

      <PitchSvg lineup={lineup} formation={formation} />

      <p className="field-hint pitch-week-caption">
        {STAGE_FULL[selected] ?? selected}
        {playedStages.includes(selected) ? "" : " (not yet played)"}
      </p>
    </div>
  );
}
