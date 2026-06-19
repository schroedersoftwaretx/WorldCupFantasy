/**
 * Player Explorer (Stats Hub) - PUBLIC.
 *
 * A sortable, filterable table of every player with tournament data: total
 * fantasy points (HUB_RULESET_VERSION) alongside raw stats. Filter by position
 * ("highest-scoring midfielders") and/or nation ("highest-scoring Spaniards"),
 * and sort by fantasy points or any raw stat. Filtering/sorting is done with a
 * plain GET form (no client JS); each player name opens the public stats modal.
 *
 * URL: /stats/players?position=MID&nation=12&sort=goals
 */
import Link from "next/link";

import type { Position } from "@/data/db/schema";
import {
  isPlayerSortKey,
  playerExplorer,
  playerExplorerNations,
  type NationOption,
  type PlayerExplorerRow,
  type PlayerSortKey,
} from "@/data/stats/player-explorer";
import { getDb } from "@/web/db";
import { HUB_RULESET_VERSION } from "@/web/stats-params";

import {
  PlayerStatsProvider,
  PlayerStatButton,
} from "../../leagues/[leagueId]/player-stats-modal";

export const dynamic = "force-dynamic";

const POSITIONS: readonly Position[] = ["GK", "DEF", "MID", "FWD"];
const POSITION_LABEL: Record<Position, string> = {
  GK: "Goalkeepers",
  DEF: "Defenders",
  MID: "Midfielders",
  FWD: "Forwards",
};
const SORT_OPTIONS: { key: PlayerSortKey; label: string }[] = [
  { key: "points", label: "Fantasy points" },
  { key: "goals", label: "Goals" },
  { key: "assists", label: "Assists" },
  { key: "saves", label: "Saves" },
  { key: "minutesPlayed", label: "Minutes" },
  { key: "appearances", label: "Appearances" },
];

function asPosition(v: string | undefined): Position | undefined {
  return v && (POSITIONS as readonly string[]).includes(v)
    ? (v as Position)
    : undefined;
}

export default async function PlayerExplorerPage({
  searchParams,
}: {
  searchParams: Promise<{ position?: string; nation?: string; sort?: string }>;
}) {
  const sp = await searchParams;
  const position = asPosition(sp.position);
  const nationId =
    sp.nation && /^\d+$/.test(sp.nation) ? Number(sp.nation) : undefined;
  const sort: PlayerSortKey =
    sp.sort && isPlayerSortKey(sp.sort) ? sp.sort : "points";

  let rows: PlayerExplorerRow[] = [];
  let nations: NationOption[] = [];
  let error: string | null = null;
  try {
    const db = getDb();
    [rows, nations] = await Promise.all([
      playerExplorer(db, {
        rulesetVersion: HUB_RULESET_VERSION,
        ...(position !== undefined ? { position } : {}),
        ...(nationId !== undefined ? { nationalTeamId: nationId } : {}),
        sort,
      }),
      playerExplorerNations(db, HUB_RULESET_VERSION),
    ]);
  } catch (e) {
    error = e instanceof Error ? e.message : "could not load players";
  }

  const nationName =
    nationId !== undefined
      ? (nations.find((n) => n.nationalTeamId === nationId)?.name ?? null)
      : null;

  return (
    <>
      <Link href="/stats" className="back-link">
        &larr; Stats Hub
      </Link>
      <h1>Player Explorer</h1>
      <p className="subtitle">
        Every player&apos;s fantasy points and raw stats, scored against the
        standard ruleset. Filter and sort, then click a name for their
        match-by-match breakdown.
      </p>

      <form className="explorer-filters" method="get" action="/stats/players">
        <label>
          Position
          <select name="position" defaultValue={position ?? ""}>
            <option value="">All positions</option>
            {POSITIONS.map((p) => (
              <option key={p} value={p}>
                {POSITION_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Nation
          <select name="nation" defaultValue={nationId ?? ""}>
            <option value="">All nations</option>
            {nations.map((n) => (
              <option key={n.nationalTeamId} value={n.nationalTeamId}>
                {n.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sort by
          <select name="sort" defaultValue={sort}>
            {SORT_OPTIONS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Apply</button>
      </form>

      <p className="subtitle">
        {position ? POSITION_LABEL[position] : "All players"}
        {nationName ? ` from ${nationName}` : ""} &middot; sorted by{" "}
        {SORT_OPTIONS.find((s) => s.key === sort)?.label ?? "Fantasy points"}.
      </p>

      {error ? (
        <p className="error">Could not load players: {error}</p>
      ) : rows.length === 0 ? (
        <p className="notice">
          No players match yet. The table fills in once matches are scored.
        </p>
      ) : (
        <PlayerStatsProvider>
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Scrollable table (use arrow keys)">
            <table>
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Player</th>
                  <th>Pos</th>
                  <th>Nation</th>
                  <th className="num">Pts</th>
                  <th className="num">Apps</th>
                  <th className="num">G</th>
                  <th className="num">A</th>
                  <th className="num">Sv</th>
                  <th className="num">Min</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.playerId}>
                    <td className="num">{i + 1}</td>
                    <td>
                      <PlayerStatButton
                        playerId={r.playerId}
                        fullName={r.fullName}
                      />
                    </td>
                    <td>{r.position}</td>
                    <td>{r.nationalTeamName}</td>
                    <td className="num">{r.points}</td>
                    <td className="num">{r.appearances}</td>
                    <td className="num">{r.goals}</td>
                    <td className="num">{r.assists}</td>
                    <td className="num">{r.saves}</td>
                    <td className="num">{r.minutesPlayed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </PlayerStatsProvider>
      )}
    </>
  );
}
