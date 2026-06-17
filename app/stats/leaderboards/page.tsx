/**
 * Public tournament leaderboards: top scorers (overall + per position), raw
 * stat leaders, form, and the biggest single-match hauls. A stage filter
 * scopes most lists to one period. No login required.
 */
import Link from "next/link";

import { stagesWithScores } from "@/data/stats/aggregate";
import type {
  MatchHaul,
  PlayerPoints,
  PlayerStatTotal,
} from "@/data/stats/aggregate";
import { getLeaderboards } from "@/data/stats/hub";
import type { Leaderboards } from "@/data/stats/hub";
import type { Position, Stage } from "@/data/db/schema";
import { getDb } from "@/web/db";
import { HUB_RULESET_VERSION, isStage } from "@/web/stats-params";

import { STAGE_FULL, STAGE_LABEL } from "../stage-labels";

export const dynamic = "force-dynamic";

const POSITIONS: { key: Position; label: string }[] = [
  { key: "GK", label: "Goalkeepers" },
  { key: "DEF", label: "Defenders" },
  { key: "MID", label: "Midfielders" },
  { key: "FWD", label: "Forwards" },
];

const STAT_LABELS: { metric: keyof Leaderboards["statLeaders"]; label: string }[] = [
  { metric: "goals", label: "Goals" },
  { metric: "assists", label: "Assists" },
  { metric: "saves", label: "Saves" },
  { metric: "minutesPlayed", label: "Minutes" },
];

function ScorerTable({ rows }: { rows: PlayerPoints[] }) {
  if (rows.length === 0) return <p className="notice">No data yet.</p>;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th className="num">#</th>
            <th>Player</th>
            <th>Nation</th>
            <th className="num">Pts</th>
            <th className="num">Apps</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.playerId}>
              <td className="num">{i + 1}</td>
              <td>{r.fullName}</td>
              <td>{r.nationalTeamName}</td>
              <td className="num">{r.points}</td>
              <td className="num">{r.appearances}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatTable({ rows }: { rows: PlayerStatTotal[] }) {
  if (rows.length === 0) return <p className="notice">No data yet.</p>;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th className="num">#</th>
            <th>Player</th>
            <th>Nation</th>
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.playerId}>
              <td className="num">{i + 1}</td>
              <td>{r.fullName}</td>
              <td>{r.nationalTeamName}</td>
              <td className="num">{r.total}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HaulTable({ rows }: { rows: MatchHaul[] }) {
  if (rows.length === 0) return <p className="notice">No data yet.</p>;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th className="num">#</th>
            <th>Player</th>
            <th>Nation</th>
            <th>Stage</th>
            <th>Opponent</th>
            <th className="num">Pts</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.playerId}-${r.fixtureId}`}>
              <td className="num">{i + 1}</td>
              <td>{r.fullName}</td>
              <td>{r.nationalTeamName}</td>
              <td>{STAGE_LABEL[r.stage]}</td>
              <td>{r.opponentTeamName || "—"}</td>
              <td className="num">{r.points}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function LeaderboardsPage({
  searchParams,
}: {
  searchParams: Promise<{ stage?: string }>;
}) {
  const sp = await searchParams;
  const stage: Stage | undefined =
    sp.stage && isStage(sp.stage) ? sp.stage : undefined;

  let data: Leaderboards | null = null;
  let scored: Stage[] = [];
  let error: string | null = null;
  try {
    const db = getDb();
    scored = await stagesWithScores(db, HUB_RULESET_VERSION);
    data = await getLeaderboards(db, {
      rulesetVersion: HUB_RULESET_VERSION,
      ...(stage !== undefined ? { stage } : {}),
    });
  } catch (e) {
    error = e instanceof Error ? e.message : "could not load leaderboards";
  }

  const href = (st: Stage | null) =>
    st === null ? "/stats/leaderboards" : `/stats/leaderboards?stage=${st}`;

  return (
    <>
      <Link href="/stats" className="back-link">
        &larr; Stats Hub
      </Link>
      <h1>Tournament Leaderboards</h1>
      <p className="subtitle">
        {stage ? STAGE_FULL[stage] : "Whole tournament"} &middot; scored against
        the standard ruleset.
      </p>

      <nav className="stage-nav" aria-label="Stage filter">
        <Link
          href={href(null)}
          className={`stage-chip${stage === undefined ? " stage-chip-active" : ""}`}
        >
          All
        </Link>
        {scored.map((st) => (
          <Link
            key={st}
            href={href(st)}
            className={`stage-chip${stage === st ? " stage-chip-active" : ""}`}
          >
            {STAGE_LABEL[st]}
          </Link>
        ))}
      </nav>

      {error ? (
        <p className="error">Could not load: {error}</p>
      ) : !data ? (
        <p className="notice">No data.</p>
      ) : (
        <>
          <h2>Top fantasy scorers</h2>
          <ScorerTable rows={data.topScorers} />

          <h2>By position</h2>
          <div className="stat-grid">
            {POSITIONS.map((p) => (
              <section key={p.key}>
                <h3>{p.label}</h3>
                <ScorerTable rows={data.byPosition[p.key]} />
              </section>
            ))}
          </div>

          <h2>In form</h2>
          <p className="subtitle">Points over each player's last 3 matches.</p>
          <ScorerTable rows={data.form} />

          <h2>Real-stat leaders</h2>
          <div className="stat-grid">
            {STAT_LABELS.map((s) => (
              <section key={s.metric}>
                <h3>{s.label}</h3>
                <StatTable rows={data.statLeaders[s.metric]} />
              </section>
            ))}
          </div>

          <h2>Biggest single-match hauls</h2>
          <HaulTable rows={data.bestHauls} />
        </>
      )}
    </>
  );
}
