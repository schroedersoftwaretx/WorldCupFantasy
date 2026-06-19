/**
 * Per-period best-ball breakdown table (client component).
 *
 * Replaces the old inline `<details>`/`<summary>` pop-up, which clipped or
 * rendered behind adjacent rows because a `<td>` doesn't establish a usable
 * stacking context. Here a cell click selects a (team, stage) pair and the XI
 * detail renders in a `position: fixed` overlay that sits above the whole
 * page, so it can never be clipped by the table. The overlay closes on an
 * outside click or the Escape key, and is full-width on small screens.
 *
 * Each player in the XI is itself clickable: it expands an inline per-rule
 * score breakdown (appearance, goals, assists, ...) fetched lazily from
 * /api/leagues/[id]/players/[playerId]/breakdown and cached per player.
 */
"use client";

import { Fragment, useEffect, useState } from "react";
import Link from "next/link";

import type { PeriodResult } from "@/data/standings/standings";
import type { PlayerBreakdown } from "@/data/standings/player-breakdown";
import { formatPoints } from "@/web/format";

/** Format a points value: trim float noise and prefix a sign. */
function signed(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  const body = Number.isInteger(rounded)
    ? String(rounded)
    : String(rounded).replace(/0+$/, "");
  return rounded > 0 ? `+${body}` : body;
}

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
  // Player-score breakdown: which player row is expanded, plus a per-player
  // fetch cache so reopening is instant and we never refetch.
  const [openPlayer, setOpenPlayer] = useState<number | null>(null);
  const [cache, setCache] = useState<Record<number, PlayerBreakdown>>({});
  const [loadingPlayer, setLoadingPlayer] = useState<number | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Escape closes the overlay.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActive(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  // Reset the expanded player whenever the overlay target changes.
  useEffect(() => {
    setOpenPlayer(null);
    setFetchError(null);
  }, [active]);

  async function togglePlayer(playerId: number): Promise<void> {
    if (openPlayer === playerId) {
      setOpenPlayer(null);
      return;
    }
    setOpenPlayer(playerId);
    setFetchError(null);
    if (cache[playerId]) return;
    setLoadingPlayer(playerId);
    try {
      const res = await fetch(
        `/api/leagues/${leagueId}/players/${playerId}/breakdown`,
      );
      const json = await res.json();
      if (!json.ok) {
        throw new Error(json.error?.message ?? "could not load breakdown");
      }
      setCache((c) => ({ ...c, [playerId]: json.data as PlayerBreakdown }));
    } catch (e) {
      setFetchError(
        e instanceof Error ? e.message : "could not load breakdown",
      );
    } finally {
      setLoadingPlayer(null);
    }
  }

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
  // Captured outside the JSX so it can be read inside the player .map callback
  // without re-narrowing the nullable `active` state there.
  const activeStageKey = active?.stage ?? null;

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
                        {formatPoints(p.points)}
                        <span className="xi-badge">{p.formation}</span>
                      </button>
                    ) : (
                      <span className="muted-pts">{formatPoints(p.points)}</span>
                    )}
                  </td>
                ))}
                <td className="num">{formatPoints(entry.total)}</td>
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
            <p className="xi-hint">
              Click a player to see their score breakdown.
            </p>
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
                  .map((slot) => {
                    const open = openPlayer === slot.playerId;
                    const data = cache[slot.playerId];
                    const stageFixtures =
                      data?.fixtures.filter((f) => f.stage === activeStageKey) ??
                      [];
                    return (
                      <Fragment key={slot.playerId}>
                        <tr
                          className={
                            open ? "xi-player-row open" : "xi-player-row"
                          }
                        >
                          <td>
                            <button
                              type="button"
                              className="xi-player-btn"
                              onClick={() => togglePlayer(slot.playerId)}
                              aria-expanded={open}
                            >
                              <span className="xi-caret">
                                {open ? "▾" : "▸"}
                              </span>{" "}
                              {slot.fullName}
                            </button>
                          </td>
                          <td className="pos-badge">{slot.position}</td>
                          <td className="num">{formatPoints(slot.points)}</td>
                        </tr>
                        {open ? (
                          <tr className="xi-breakdown-row">
                            <td colSpan={3}>
                              {loadingPlayer === slot.playerId ? (
                                <p className="xi-bd-status">Loading&hellip;</p>
                              ) : fetchError ? (
                                <p className="xi-bd-status error">
                                  {fetchError}
                                </p>
                              ) : stageFixtures.length === 0 ? (
                                <p className="xi-bd-status">
                                  No scored fixture for this period.
                                </p>
                              ) : (
                                stageFixtures.map((fx) => (
                                  <div
                                    key={fx.fixtureId}
                                    className="xi-bd-fixture"
                                  >
                                    <div className="xi-bd-head">
                                      <span>{fx.opponent}</span>
                                      <span className="num">
                                        {signed(fx.total)}
                                      </span>
                                    </div>
                                    <ul className="xi-bd-rules">
                                      {fx.rules.map((r) => (
                                        <li key={r.key}>
                                          <span className="xi-bd-label">
                                            {r.label}
                                            {r.count !== null ? (
                                              <span className="xi-bd-count">
                                                {" "}
                                                &times;{r.count}
                                              </span>
                                            ) : null}
                                          </span>
                                          <span
                                            className={
                                              r.points < 0
                                                ? "xi-bd-pts neg"
                                                : "xi-bd-pts"
                                            }
                                          >
                                            {signed(r.points)}
                                          </span>
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                ))
                              )}
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </>
  );
}
