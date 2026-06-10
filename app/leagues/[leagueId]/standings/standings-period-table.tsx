/**
 * Per-period best-ball breakdown table (client component).
 *
 * Replaces the old inline `<details>`/`<summary>` pop-up, which clipped or
 * rendered behind adjacent rows because a `<td>` doesn't establish a usable
 * stacking context. Here a cell click selects a (team, stage) pair and the XI
 * detail renders in a `position: fixed` overlay that sits above the whole
 * page, so it can never be clipped by the table. The overlay closes on an
 * outside click or the Escape key, and is full-width on small screens.
 */
"use client";

import { useEffect } from "react";
import { useState } from "react";
import Link from "next/link";

import type { PeriodResult } from "@/data/standings/standings";

export interface PeriodTableRow {
  fantasyTeamId: number;
  teamName: string;
  periods: PeriodResult[];
  total: number;
}

interface Props {
  leagueId: number;
  /** Stage keys, in column order. */
  stages: string[];
  /** Short column labels, e.g. { FINAL: "Final" }. */
  stageLabel: Record<string, string>;
  /** Full names for the overlay header, e.g. { FINAL: "Final" }. */
  stageFull: Record<string, string>;
  rows: PeriodTableRow[];
}

interface Active {
  teamId: number;
  stage: string;
}

export default function StandingsPeriodTable({
  leagueId,
  stages,
  stageLabel,
  stageFull,
  rows,
}: Props) {
  const [active, setActive] = useState<Active | null>(null);

  // Escape closes the overlay.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActive(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  const isActive = (teamId: number, stage: string): boolean =>
    active !== null && active.teamId === teamId && active.stage === stage;

  const toggle = (teamId: number, stage: string): void =>
    setActive((a) =>
      a && a.teamId === teamId && a.stage === stage ? null : { teamId, stage },
    );

  const activeRow = active
    ? rows.find((r) => r.fantasyTeamId === active.teamId) ?? null
    : null;
  const activePeriod =
    activeRow && active
      ? activeRow.periods.find((p) => p.stage === active.stage) ?? null
      : null;

  return (
    <>
      <div className="table-scroll">
        <table className="period-table">
          <thead>
            <tr>
              <th>Team</th>
              {stages.map((stage) => (
                <th key={stage} className="num">
                  {stageLabel[stage] ?? stage}
                </th>
              ))}
              <th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((entry) => (
              <tr key={entry.fantasyTeamId}>
                <td>
                  <Link
                    href={`/leagues/${leagueId}/roster/${entry.fantasyTeamId}`}
                    className="team-link"
                  >
                    {entry.teamName}
                  </Link>
                </td>
                {entry.periods.map((p) => (
                  <td key={p.stage} className="num period-cell">
                    {p.xi.length > 0 ? (
                      <button
                        type="button"
                        className={
                          isActive(entry.fantasyTeamId, p.stage)
                            ? "xi-cell-btn active"
                            : "xi-cell-btn"
                        }
                        onClick={() => toggle(entry.fantasyTeamId, p.stage)}
                      >
                        {p.points}
                        <span className="xi-badge">{p.formation}</span>
                      </button>
                    ) : (
                      <span className="muted-pts">{p.points}</span>
                    )}
                  </td>
                ))}
                <td className="num">{entry.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {active && activeRow && activePeriod ? (
        <div
          className="xi-overlay"
          onClick={() => setActive(null)}
          role="presentation"
        >
          <div
            className="xi-overlay-panel"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="xi-overlay-header">
              <span>
                {stageFull[active.stage] ?? active.stage} &mdash;{" "}
                {activeRow.teamName} &mdash; {activePeriod.formation}
              </span>
              <button
                type="button"
                className="xi-overlay-close"
                onClick={() => setActive(null)}
                aria-label="Close"
              >
                &times;
              </button>
            </div>
            <table className="xi-table">
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Pos</th>
                  <th className="num">Pts</th>
                </tr>
              </thead>
              <tbody>
                {[...activePeriod.xi]
                  .sort(
                    (a, b) =>
                      b.points - a.points ||
                      a.fullName.localeCompare(b.fullName),
                  )
                  .map((slot) => (
                    <tr key={slot.playerId}>
                      <td>{slot.fullName}</td>
                      <td className="pos-badge">{slot.position}</td>
                      <td className="num">{slot.points}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </>
  );
}
