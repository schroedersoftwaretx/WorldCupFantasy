/**
 * The available-player board (client component).
 *
 * A searchable, filterable list of undrafted players. The "Draft" button is
 * enabled only when it is the viewer's turn and the player would be a legal
 * roster addition; the server re-validates every pick regardless.
 */
"use client";

import { useMemo, useState } from "react";

import type { DraftBoardPlayer } from "@/web/api-types";

interface PlayerBoardProps {
  players: DraftBoardPlayer[];
  canDraft: boolean;
  busy: boolean;
  onDraft: (playerId: number) => void;
}

const POSITIONS = ["GK", "DEF", "MID", "FWD"];
const MAX_ROWS = 200;
type SortKey = "rank" | "proj" | "name" | "pos";
const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "rank", label: "Rank" },
  { value: "proj", label: "Proj. Pts" },
  { value: "name", label: "Name" },
  { value: "pos",  label: "Position" },
];

export default function PlayerBoard({
  players,
  canDraft,
  busy,
  onDraft,
}: PlayerBoardProps) {
  const [search, setSearch] = useState("");
  const [position, setPosition] = useState("ALL");
  const [team, setTeam] = useState("ALL");
  const [sort, setSort] = useState<SortKey>("rank");

  const teams = useMemo(
    () => Array.from(new Set(players.map((p) => p.nationalTeam))).sort(),
    [players],
  );

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
      if (sort === "name") return a.fullName.localeCompare(b.fullName);
      if (sort === "pos")  return (POS_ORDER[a.position] ?? 9) - (POS_ORDER[b.position] ?? 9);
      const ra = (a.draftRank != null && a.draftRank > 0) ? a.draftRank : 9999;
      const rb = (b.draftRank != null && b.draftRank > 0) ? b.draftRank : 9999;
      return ra - rb;
    });
    return list;
  }, [players, search, position, team, sort]);

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
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          aria-label="Sort by"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              Sort: {o.label}
            </option>
          ))}
        </select>
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
        <div className="board-scroll">
          <table>
            <thead>
              <tr>
                <th className="num">Rank</th>
                <th className="num">Proj. Pts</th>
                <th>Player</th>
                <th>Pos</th>
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
                  <td>{p.fullName}</td>
                  <td>
                    <span className="pos-badge">{p.position}</span>
                  </td>
                  <td>{p.nationalTeam}</td>
                  <td>
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
