/**
 * RosterPitch (client) — the per-week pitch + stats on the roster page.
 *
 * Shows the best-ball XI for ONE scoring period at a time on the SVG pitch,
 * plus a table of every appeared player's goals / assists / points for that
 * week. Within the selected period the XI fills in gradually as that week's
 * matches are played (only players who have featured are placed; the rest are
 * empty slots), and the formation re-optimises as scores arrive.
 *
 * A week selector lets the manager flip back to prior periods' lineups, and an
 * "All" option shows the single best XI across the WHOLE tournament (each
 * player's cumulative points) with season-long goals / assists / points.
 */
"use client";

import { useMemo, useState } from "react";

import type { RosterPlayerScore } from "@/web/api-types";
import { formatPoints } from "@/web/format";

import { PlayerStatButton } from "../../player-stats-modal";
import {
  PitchSvg,
  computePeriodLineup,
  type Lineup,
  type Player,
} from "../../draft/best-lineup";

/** Sentinel for the whole-tournament view in the selector. */
const ALL = "ALL";

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

/** Position display order for the per-week table. */
const POSITION_ORDER: readonly string[] = ["GK", "DEF", "MID", "FWD"];

/** Collect the playerIds that ended up in a computed lineup. */
function xiIdsOf(lineup: Lineup): Set<number> {
  const ids = new Set<number>();
  for (const row of [lineup.gk, lineup.def, lineup.mid, lineup.fwd]) {
    for (const slot of row) {
      if (slot.playerId !== undefined) ids.add(slot.playerId);
    }
  }
  return ids;
}

/** One row in the per-week / all-tournament stats table. */
interface StatRow {
  playerId: number;
  fullName: string;
  position: string;
  goals: number;
  assists: number;
  points: number;
}

export function RosterPitch({ players }: { players: RosterPlayerScore[] }) {
  // The weeks that have any result yet: these are the periods you can review.
  const playedStages = useMemo(() => {
    const set = new Set<string>();
    for (const p of players) {
      for (const pd of p.periods) if (pd.appeared) set.add(pd.stage);
    }
    return STAGE_ORDER.filter((s) => set.has(s));
  }, [players]);

  const hasAnyResult = playedStages.length > 0;

  const [stage, setStage] = useState<string | null>(null);
  // Default to the most recent played week; before any results, the first
  // period (shown as an empty default skeleton).
  const selected =
    stage && (stage === ALL || playedStages.includes(stage))
      ? stage
      : (playedStages[playedStages.length - 1] ?? STAGE_ORDER[0] ?? "GROUP_1");

  const isAll = selected === ALL;

  // The players fed to the pitch optimizer: for a single week, that week's
  // points + appearance; for "All", cumulative points across every period and
  // appeared if they featured in ANY period (so the season-best XI is a single
  // fixed eleven by total points).
  const periodPlayers: Player[] = useMemo(
    () =>
      players.map((p) => {
        if (isAll) {
          const points = p.periods.reduce((s, pd) => s + pd.points, 0);
          const appeared = p.periods.some((pd) => pd.appeared);
          return {
            playerId: p.playerId,
            fullName: p.fullName,
            position: p.position,
            points,
            appeared,
          };
        }
        const pd = p.periods.find((x) => x.stage === selected);
        return {
          playerId: p.playerId,
          fullName: p.fullName,
          position: p.position,
          points: pd?.points ?? 0,
          appeared: pd?.appeared ?? false,
        };
      }),
    [players, selected, isAll],
  );

  const { lineup, formation } = useMemo(
    () => computePeriodLineup(periodPlayers),
    [periodPlayers],
  );

  const xiIds = useMemo(() => xiIdsOf(lineup), [lineup]);

  // Rows for the stats table: only players who featured in the selected view,
  // with goals / assists / points for that week (or season totals for "All").
  const statRows: StatRow[] = useMemo(() => {
    const rows: StatRow[] = [];
    for (const p of players) {
      if (isAll) {
        const appeared = p.periods.some((pd) => pd.appeared);
        if (!appeared) continue;
        rows.push({
          playerId: p.playerId,
          fullName: p.fullName,
          position: p.position,
          goals: p.periods.reduce((s, pd) => s + pd.goals, 0),
          assists: p.periods.reduce((s, pd) => s + pd.assists, 0),
          points: p.periods.reduce((s, pd) => s + pd.points, 0),
        });
      } else {
        const pd = p.periods.find((x) => x.stage === selected);
        if (!pd?.appeared) continue;
        rows.push({
          playerId: p.playerId,
          fullName: p.fullName,
          position: p.position,
          goals: pd.goals,
          assists: pd.assists,
          points: pd.points,
        });
      }
    }
    rows.sort(
      (a, b) =>
        b.points - a.points ||
        b.goals - a.goals ||
        b.assists - a.assists ||
        a.fullName.localeCompare(b.fullName),
    );
    return rows;
  }, [players, selected, isAll]);

  const totals = useMemo(
    () => ({
      goals: statRows.filter((r) => xiIds.has(r.playerId)).reduce((s, r) => s + r.goals, 0),
      assists: statRows
        .filter((r) => xiIds.has(r.playerId))
        .reduce((s, r) => s + r.assists, 0),
      points: statRows
        .filter((r) => xiIds.has(r.playerId))
        .reduce((s, r) => s + r.points, 0),
    }),
    [statRows, xiIds],
  );

  return (
    <div className="roster-pitch">
      {hasAnyResult ? (
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
          <button
            type="button"
            className={`stage-chip${isAll ? " stage-chip-active" : ""}`}
            aria-pressed={isAll}
            onClick={() => setStage(ALL)}
            title="Best XI across the whole tournament"
          >
            All
          </button>
        </nav>
      ) : (
        <p className="field-hint">
          No matches scored yet &mdash; your XI fills in here as each week&apos;s
          games are played.
        </p>
      )}

      <PitchSvg lineup={lineup} formation={formation} />

      <p className="field-hint pitch-week-caption">
        {isAll
          ? "Best XI — whole tournament"
          : (STAGE_FULL[selected] ?? selected) +
            (playedStages.includes(selected) ? "" : " (not yet played)")}
      </p>

      {statRows.length > 0 ? (
        <div className="pitch-week-stats">
          <p className="field-hint">
            {isAll
              ? "Season totals for players who have featured. Highlighted rows are in the all-tournament best XI."
              : "Goals, assists and points for this week. Highlighted rows are in this week's best-ball XI."}
          </p>
          <div
            className="table-scroll"
            tabIndex={0}
            role="region"
            aria-label="Scrollable table (use arrow keys)"
          >
            <table>
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Pos</th>
                  <th className="num">G</th>
                  <th className="num">A</th>
                  <th className="num">Pts</th>
                </tr>
              </thead>
              <tbody>
                {statRows.map((r) => (
                  <tr
                    key={r.playerId}
                    className={xiIds.has(r.playerId) ? "row-has-xi" : undefined}
                  >
                    <td className="player-name-cell">
                      <PlayerStatButton
                        playerId={r.playerId}
                        fullName={r.fullName}
                        className="player-stat-link"
                      />
                    </td>
                    <td className="muted-cell">{r.position}</td>
                    <td className="num">{r.goals}</td>
                    <td className="num">{r.assists}</td>
                    <td className="num">{formatPoints(r.points)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2}>Best-ball XI total</td>
                  <td className="num">{totals.goals}</td>
                  <td className="num">{totals.assists}</td>
                  <td className="num player-total">
                    {formatPoints(totals.points)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
