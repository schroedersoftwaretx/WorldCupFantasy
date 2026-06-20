/**
 * Draft results page (post-draft improvements, A1 + A2).
 *
 * The classic snake-draft recap board: rounds down the rows, teams (in
 * draft-slot order) across the columns, each cell one pick color-coded by
 * position with the player's national-team flag. Column headers carry each
 * team's projected total and curved letter grade; below the grid, the
 * draft's best values and biggest reaches, and a collapsible per-team
 * roster recap.
 *
 * Server component, pure read - all math lives in @/web/draft-results.
 * Auth- and membership-gated like every league page.
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import {
  getDraftResults,
  type DraftResultsData,
  type DraftResultsPick,
} from "@/web/draft-results";
import { flagImg } from "@/web/flags";
import { getMembershipRole } from "@/web/queries";

export const dynamic = "force-dynamic";

function Flag({ country }: { country: string }) {
  const f = flagImg(country);
  if (!f) return null;
  return (
    <img
      className="flag"
      src={f.src}
      srcSet={f.srcSet}
      width={20}
      height={15}
      alt=""
      loading="lazy"
    />
  );
}

function posClass(position: string): string {
  switch (position) {
    case "GK":
      return "pick-gk";
    case "DEF":
      return "pick-def";
    case "MID":
      return "pick-mid";
    case "FWD":
      return "pick-fwd";
    default:
      return "";
  }
}

function ValueList({
  title,
  hint,
  picks,
}: {
  title: string;
  hint: string;
  picks: DraftResultsPick[];
}) {
  return (
    <section className="panel value-panel">
      <h2>{title}</h2>
      <p className="field-hint">{hint}</p>
      {picks.length === 0 ? (
        <p className="notice">Nothing stands out.</p>
      ) : (
        <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Player</th>
              <th>Team</th>
              <th className="num">Pick</th>
              <th className="num">Proj. rank</th>
              <th className="num">Value</th>
            </tr>
          </thead>
          <tbody>
            {picks.map((p) => (
              <tr key={p.pickNumber}>
                <td>
                  <Flag country={p.nationalTeam} />
                  {p.playerName}{" "}
                  <span className={`pos-chip ${posClass(p.position)}`}>
                    {p.position}
                  </span>
                </td>
                <td>{p.teamName}</td>
                <td className="num">#{p.pickNumber}</td>
                <td className="num">{p.projectedRank ?? "-"}</td>
                <td className="num">
                  {(p.value ?? 0) > 0 ? `+${p.value}` : p.value}
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

export default async function DraftResultsPage({
  params,
}: {
  params: Promise<{ leagueId: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { leagueId } = await params;
  const id = Number(leagueId);
  const validId = Number.isInteger(id) && id > 0;

  const back = (
    <Link href={validId ? `/leagues/${id}` : "/"} className="back-link">
      &larr; {validId ? "Back to league" : "Your leagues"}
    </Link>
  );

  if (!validId) {
    return (
      <>
        {back}
        <p className="error">Invalid league id: {leagueId}</p>
      </>
    );
  }

  let role: string | null = null;
  let data: DraftResultsData | null = null;
  let error: string | null = null;
  try {
    const db = getDb();
    role = await getMembershipRole(db, id, user.manager.id);
    if (role) data = await getDraftResults(db, id);
  } catch (e) {
    error = e instanceof Error ? e.message : "could not load draft results";
  }

  if (error) {
    return (
      <>
        {back}
        <p className="error">Could not load draft results: {error}</p>
      </>
    );
  }
  if (!role) {
    return (
      <>
        {back}
        <p className="notice">League not found, or you are not a member.</p>
      </>
    );
  }
  if (!data || data.picks.length === 0) {
    return (
      <>
        {back}
        <p className="notice">
          No draft picks yet.{" "}
          <Link href={`/leagues/${id}/draft`}>Go to the draft room &rarr;</Link>
        </p>
      </>
    );
  }

  // (round, slot) -> pick, for the grid.
  const pickByCell = new Map<string, DraftResultsPick>();
  for (const p of data.picks) pickByCell.set(`${p.round}:${p.slot}`, p);
  const rounds = Array.from({ length: data.rounds }, (_, i) => i + 1);

  // Per-team rosters for the recap, in slot order.
  const picksByTeam = new Map<number, DraftResultsPick[]>();
  for (const p of data.picks) {
    const list = picksByTeam.get(p.fantasyTeamId) ?? [];
    list.push(p);
    picksByTeam.set(p.fantasyTeamId, list);
  }
  const POSITIONS = ["GK", "DEF", "MID", "FWD"];

  return (
    <>
      {back}
      <h1>
        Draft results
        <span className="tag">
          {data.status === "COMPLETE" ? "COMPLETE" : data.status}
        </span>
      </h1>
      <p className="subtitle">
        {data.leagueName} &mdash; {data.picks.length} picks,{" "}
        {data.teams.length} teams. Snake order: odd rounds run left to right,
        even rounds run right to left.
        {data.hasProjections
          ? " Grades curve each team's summed projected points against the league."
          : ""}
      </p>

      {/* ---- The board ---- */}
      <div className="table-scroll">
        <table className="draft-board">
          <thead>
            <tr>
              <th className="num">Rd</th>
              {data.teams.map((t) => (
                <th key={t.fantasyTeamId}>
                  <div className="board-team">{t.teamName}</div>
                  <div className="board-manager">{t.managerName}</div>
                  {t.projectedTotal !== null ? (
                    <div className="board-grade">
                      <span className="grade-badge">{t.grade}</span>{" "}
                      {t.projectedTotal} proj
                    </div>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rounds.map((round) => (
              <tr key={round}>
                <td className="num round-cell">
                  {round}
                  <span className="snake-dir">
                    {round % 2 === 1 ? "\u2192" : "\u2190"}
                  </span>
                </td>
                {data.teams.map((t) => {
                  const p = pickByCell.get(`${round}:${t.slot}`);
                  if (!p) {
                    return (
                      <td key={t.fantasyTeamId} className="pick-cell empty" />
                    );
                  }
                  return (
                    <td
                      key={t.fantasyTeamId}
                      className={`pick-cell ${posClass(p.position)}`}
                    >
                      <div className="pick-meta">
                        #{p.pickNumber}
                        {p.isAutopick ? (
                          <span
                            className="autopick-mark"
                            title="Autopicked"
                          >
                            A
                          </span>
                        ) : null}
                      </div>
                      <div className="pick-player">
                        <Flag country={p.nationalTeam} />
                        {p.playerName}
                      </div>
                      <div className="pick-pos">{p.position}</div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ---- Values & reaches ---- */}
      {data.hasProjections ? (
        <div className="value-grid">
          <ValueList
            title="Best values"
            hint="Players taken well after their projected rank."
            picks={data.bestValues}
          />
          <ValueList
            title="Biggest reaches"
            hint="Players taken well before their projected rank."
            picks={data.biggestReaches}
          />
        </div>
      ) : (
        <p className="notice">
          Projections are not ingested, so grades, values and reaches are
          hidden. Run the odds/projections ingest to light them up.
        </p>
      )}

      {/* ---- Per-team recap ---- */}
      <h2>Rosters</h2>
      {data.teams.map((t) => {
        const teamPicks = picksByTeam.get(t.fantasyTeamId) ?? [];
        return (
          <details key={t.fantasyTeamId} className="roster-recap">
            <summary>
              {t.teamName}
              {t.grade ? <span className="grade-badge">{t.grade}</span> : null}
              <span className="muted-cell"> {t.managerName}</span>
            </summary>
            <div className="roster-recap-body">
              {POSITIONS.map((pos) => {
                const group = teamPicks.filter((p) => p.position === pos);
                if (group.length === 0) return null;
                return (
                  <div key={pos} className="roster-recap-group">
                    <span className={`pos-chip ${posClass(pos)}`}>{pos}</span>
                    <ul>
                      {group.map((p) => (
                        <li key={p.pickNumber}>
                          <Flag country={p.nationalTeam} />
                          {p.playerName}{" "}
                          <span className="muted-cell">
                            (pick #{p.pickNumber}
                            {p.projectedPoints !== null
                              ? `, ${p.projectedPoints} proj`
                              : ""}
                            )
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          </details>
        );
      })}

      <p className="lead-link">
        <Link href={`/leagues/${id}/standings`}>View standings &rarr;</Link>
      </p>
    </>
  );
}
