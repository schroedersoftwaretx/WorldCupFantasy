/**
 * The available-player board (client component).
 *
 * A searchable, filterable list of undrafted players. The "Draft" button is
 * enabled only when it is the viewer's turn and the player would be a legal
 * roster addition; the server re-validates every pick regardless.
 */
"use client";

import { useMemo, useState } from "react";

import type { DraftBoardPlayer, StageKey } from "@/web/api-types";
import { STAGE_LABELS, STAGE_ORDER } from "@/web/api-types";
import { flagImg } from "@/web/flags";

interface PlayerBoardProps {
  players: DraftBoardPlayer[];
  canDraft: boolean;
  busy: boolean;
  onDraft: (playerId: number) => void;
  /** Player ids currently in the viewer's queue (for the toggle state). */
  queuedIds?: ReadonlySet<number>;
  /** Add/remove a player from the viewer's queue. */
  onToggleQueue?: (playerId: number, queued: boolean) => void;
}

const POSITIONS = ["GK", "DEF", "MID", "FWD"];
const MAX_ROWS = 200;
type SortKey = "rank" | "proj" | "adp" | "stage" | "name" | "pos";

export default function PlayerBoard({
  players,
  canDraft,
  busy,
  onDraft,
  queuedIds,
  onToggleQueue,
}: PlayerBoardProps) {
  const [search, setSearch] = useState("");
  const [position, setPosition] = useState("ALL");
  const [team, setTeam] = useState("ALL");
  // Default sort: descending projected points (the projection system's pick).
  const [sort, setSort] = useState<SortKey>("proj");

  // Click a column header to sort by it. Clicking the active column does
  // nothing extra — each key has a single, sensible direction (proj desc,
  // everything else ascending), so there is no confusing toggle to track.
  function sortBy(key: SortKey) {
    setSort(key);
  }
  const sortArrow = (key: SortKey) => (sort === key ? " ↓" : "");

  const teams = useMemo(
    () => Array.from(new Set(players.map((p) => p.nationalTeam))).sort(),
    [players],
  );

  // Which reach-stages have data for at least one player (earliest -> latest).
  const availableStages = useMemo<StageKey[]>(
    () =>
      STAGE_ORDER.filter((s) =>
        players.some((p) => p.stageProbabilities?.[s] != null),
      ),
    [players],
  );

  // The stage shown in the odds column. Default to the deepest stage that has
  // data (most differentiating for a draft), falling back to the first.
  const [stage, setStage] = useState<StageKey | null>(null);
  const selectedStage: StageKey | null =
    stage && availableStages.includes(stage)
      ? stage
      : (availableStages[availableStages.length - 1] ?? null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = players.filter((p) => {
      if (position !== "ALL" && p.position !== position) return false;
      if (team !== "ALL" && p.nationalTeam !== team) return false;
      if (q && !p.fullName.toLowerCase().includes(q)) return false;
      return true;
    });
    const POS_ORDER: Record<string, number> = { GK: 0, DEF: 1, MID: 2, FWD: 3 };
    list.sort((a, b) => {
      if (sort === "proj") return (b.projectedTotalPoints ?? -1) - (a.projectedTotalPoints ?? -1);
      if (sort === "adp") {
        // Lowest ADP (earliest off the board) first; never-drafted last.
        const aa = a.adp ?? Number.POSITIVE_INFINITY;
        const bb = b.adp ?? Number.POSITIVE_INFINITY;
        return aa - bb;
      }
      if (sort === "stage" && selectedStage) {
        const av = a.stageProbabilities?.[selectedStage] ?? -1;
        const bv = b.stageProbabilities?.[selectedStage] ?? -1;
        return bv - av;
      }
      if (sort === "name") return a.fullName.localeCompare(b.fullName);
      if (sort === "pos")  return (POS_ORDER[a.position] ?? 9) - (POS_ORDER[b.position] ?? 9);
      const ra = (a.draftRank != null && a.draftRank > 0) ? a.draftRank : 9999;
      const rb = (b.draftRank != null && b.draftRank > 0) ? b.draftRank : 9999;
      return ra - rb;
    });
    return list;
  }, [players, search, position, team, sort, selectedStage]);

  const shown = filtered.slice(0, MAX_ROWS);

  return (
    <section className="panel">
      <h2>Available players</h2>
      <div className="board-filters">
        <input
          type="text"
          placeholder="Search by name"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          value={position}
          onChange={(e) => setPosition(e.target.value)}
          aria-label="Filter by position"
        >
          <option value="ALL">All positions</option>
          {POSITIONS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select
          value={team}
          onChange={(e) => setTeam(e.target.value)}
          aria-label="Filter by national team"
        >
          <option value="ALL">All teams</option>
          {teams.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        {availableStages.length > 0 && selectedStage ? (
          <select
            value={selectedStage}
            onChange={(e) => {
              setStage(e.target.value as StageKey);
              setSort("stage");
            }}
            aria-label="Tournament-stage odds to display"
            title="Show each team's chance of reaching this stage"
          >
            {availableStages.map((s) => (
              <option key={s} value={s}>
                Chance to reach: {STAGE_LABELS[s].full}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <p className="field-hint">
        {filtered.length} available
        {filtered.length > shown.length
          ? ` (showing the first ${shown.length} - narrow the filters)`
          : ""}
        {canDraft ? " - it's your pick" : " - not your pick"}
      </p>
      {shown.length === 0 ? (
        <p className="notice">No players match those filters.</p>
      ) : (
        <div
          className="board-scroll"
          tabIndex={0}
          role="region"
          aria-label="Available players (scrollable, use arrow keys)"
        >
          <table>
            <thead>
              <tr>
                <th className="num">
                  <button
                    type="button"
                    className="sort-th"
                    aria-pressed={sort === "rank"}
                    onClick={() => sortBy("rank")}
                  >
                    Rank{sortArrow("rank")}
                  </button>
                </th>
                <th className="num">
                  <button
                    type="button"
                    className="sort-th"
                    aria-pressed={sort === "proj"}
                    onClick={() => sortBy("proj")}
                  >
                    Proj. Pts{sortArrow("proj")}
                  </button>
                </th>
                <th className="num">
                  <button
                    type="button"
                    className="sort-th"
                    aria-pressed={sort === "adp"}
                    onClick={() => sortBy("adp")}
                    title="Average draft position across all leagues (live ADP)"
                  >
                    ADP{sortArrow("adp")}
                  </button>
                </th>
                {selectedStage ? (
                  <th className="num">
                    <button
                      type="button"
                      className="sort-th"
                      aria-pressed={sort === "stage"}
                      onClick={() => sortBy("stage")}
                      title={`Chance this player's national team reaches the ${STAGE_LABELS[selectedStage].full}`}
                    >
                      {STAGE_LABELS[selectedStage].short}%{sortArrow("stage")}
                    </button>
                  </th>
                ) : null}
                <th>
                  <button
                    type="button"
                    className="sort-th"
                    aria-pressed={sort === "name"}
                    onClick={() => sortBy("name")}
                  >
                    Player{sortArrow("name")}
                  </button>
                </th>
                <th>
                  <button
                    type="button"
                    className="sort-th"
                    aria-pressed={sort === "pos"}
                    onClick={() => sortBy("pos")}
                  >
                    Pos{sortArrow("pos")}
                  </button>
                </th>
                <th>Team</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id}>
                  <td className="num">{p.draftRank != null && p.draftRank > 0 ? p.draftRank : "-"}</td>
                  <td className="num">
                    {p.projectedTotalPoints !== null
                      ? p.projectedTotalPoints.toFixed(1)
                      : "-"}
                  </td>
                  <td className="num">{p.adp != null ? p.adp : "-"}</td>
                  {selectedStage ? (
                    <td className="num">
                      {(() => {
                        const v = p.stageProbabilities?.[selectedStage];
                        return v != null ? `${Math.round(v * 100)}%` : "-";
                      })()}
                    </td>
                  ) : null}
                  <td>{p.fullName}</td>
                  <td>
                    <span className="pos-badge">{p.position}</span>
                  </td>
                  <td>
                    {(() => {
                      const f = flagImg(p.nationalTeam);
                      return f ? (
                        <img
                          className="flag"
                          src={f.src}
                          srcSet={f.srcSet}
                          width={20}
                          height={15}
                          alt=""
                          loading="lazy"
                        />
                      ) : null;
                    })()}
                    {p.nationalTeam}
                  </td>
                  <td>
                    <div className="board-actions">
                      <button
                        type="button"
                        className="btn-sm"
                        disabled={!canDraft || !p.legal || busy}
                        title={
                          p.legal
                            ? "Draft this player"
                            : "Adding this player would break your roster minimums or caps"
                        }
                        onClick={() => onDraft(p.id)}
                      >
                        Draft
                      </button>
                      {onToggleQueue ? (
                        (() => {
                          const queued = queuedIds?.has(p.id) ?? false;
                          return (
                            <button
                              type="button"
                              className={
                                queued ? "btn-sm btn-queued" : "btn-sm btn-queue"
                              }
                              aria-pressed={queued}
                              title={
                                queued
                                  ? "Remove from your pick queue"
                                  : "Add to your pick queue"
                              }
                              onClick={() => onToggleQueue(p.id, !queued)}
                            >
                              {queued ? "Queued" : "+ Queue"}
                            </button>
                          );
                        })()
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
