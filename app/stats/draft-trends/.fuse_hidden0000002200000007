/**
 * Draft Trends table (client): sortable + filterable view of ADP, ownership %,
 * and reach/steal. Pure presentation over the precomputed rows the public page
 * passes in — no fetching, no league context.
 */
"use client";

import { useMemo, useState } from "react";

import type { DraftTrendRow } from "@/data/stats/hub";
import { flagImg } from "@/web/flags";

type SortKey = "adp" | "ownership" | "reach" | "take" | "name";

const POSITIONS = ["GK", "DEF", "MID", "FWD"];

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** Signed reach/steal: negative = drafted earlier than rank (a reach). */
function signed(n: number): string {
  const r = Math.round(n * 10) / 10;
  return r > 0 ? `+${r}` : String(r);
}

export function DraftTrendsTable({
  rows,
  totalDrafts,
  totalFantasyTeams,
}: {
  rows: DraftTrendRow[];
  totalDrafts: number;
  totalFantasyTeams: number;
}) {
  const [position, setPosition] = useState("ALL");
  const [nation, setNation] = useState("ALL");
  const [sort, setSort] = useState<SortKey>("adp");

  const nations = useMemo(
    () => Array.from(new Set(rows.map((r) => r.nationalTeamName))).sort(),
    [rows],
  );

  const sortArrow = (key: SortKey) => (sort === key ? ` ${"↓"}` : "");

  const filtered = useMemo(() => {
    const list = rows.filter((r) => {
      if (position !== "ALL" && r.position !== position) return false;
      if (nation !== "ALL" && r.nationalTeamName !== nation) return false;
      return true;
    });
    list.sort((a, b) => {
      switch (sort) {
        case "adp":
          return a.adp - b.adp || a.playerId - b.playerId;
        case "ownership":
          return b.ownershipPct - a.ownershipPct || a.adp - b.adp;
        case "take":
          return b.takeRate - a.takeRate || a.adp - b.adp;
        case "reach": {
          // Biggest reaches first (most negative). Unranked sort last.
          const av = a.reachSteal ?? Number.POSITIVE_INFINITY;
          const bv = b.reachSteal ?? Number.POSITIVE_INFINITY;
          return av - bv || a.adp - b.adp;
        }
        case "name":
          return a.fullName.localeCompare(b.fullName);
        default:
          return 0;
      }
    });
    return list;
  }, [rows, position, nation, sort]);

  return (
    <>
      <p className="subtitle">
        Across {totalDrafts} {totalDrafts === 1 ? "draft" : "drafts"} and{" "}
        {totalFantasyTeams} fantasy{" "}
        {totalFantasyTeams === 1 ? "team" : "teams"}. ADP is the average overall
        pick; reach/steal is ADP minus a player&apos;s pre-tournament rank
        (negative = drafted earlier than ranked).
      </p>

      <div className="board-filters">
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
          value={nation}
          onChange={(e) => setNation(e.target.value)}
          aria-label="Filter by nation"
        >
          <option value="ALL">All nations</option>
          {nations.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>

      <p className="field-hint">{filtered.length} players</p>

      {filtered.length === 0 ? (
        <p className="notice">No players match those filters.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>
                  <button
                    type="button"
                    className="sort-th"
                    aria-pressed={sort === "name"}
                    onClick={() => setSort("name")}
                  >
                    Player{sortArrow("name")}
                  </button>
                </th>
                <th>Pos</th>
                <th>Nation</th>
                <th className="num">
                  <button
                    type="button"
                    className="sort-th"
                    aria-pressed={sort === "adp"}
                    onClick={() => setSort("adp")}
                  >
                    ADP{sortArrow("adp")}
                  </button>
                </th>
                <th className="num">Range</th>
                <th className="num">
                  <button
                    type="button"
                    className="sort-th"
                    aria-pressed={sort === "take"}
                    onClick={() => setSort("take")}
                  >
                    Take%{sortArrow("take")}
                  </button>
                </th>
                <th className="num">Rank</th>
                <th className="num">
                  <button
                    type="button"
                    className="sort-th"
                    aria-pressed={sort === "reach"}
                    onClick={() => setSort("reach")}
                    title="ADP minus draft rank: negative = drafted earlier than ranked (a reach)"
                  >
                    Reach/Steal{sortArrow("reach")}
                  </button>
                </th>
                <th className="num">
                  <button
                    type="button"
                    className="sort-th"
                    aria-pressed={sort === "ownership"}
                    onClick={() => setSort("ownership")}
                  >
                    Owned%{sortArrow("ownership")}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.playerId}>
                  <td>{r.fullName}</td>
                  <td>
                    <span className="pos-badge">{r.position}</span>
                  </td>
                  <td>
                    {(() => {
                      const f = flagImg(r.nationalTeamName);
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
                    {r.nationalTeamName}
                  </td>
                  <td className="num">{r.adp}</td>
                  <td className="num">
                    {r.earliestPick}&ndash;{r.latestPick}
                  </td>
                  <td className="num">{pct(r.takeRate)}</td>
                  <td className="num">{r.draftRank ?? "-"}</td>
                  <td className="num">
                    {r.reachSteal === null ? (
                      "-"
                    ) : (
                      <span className={r.reachSteal < 0 ? "xi-bd-pts neg" : "xi-bd-pts"}>
                        {signed(r.reachSteal)}
                      </span>
                    )}
                  </td>
                  <td className="num">{pct(r.ownershipPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
