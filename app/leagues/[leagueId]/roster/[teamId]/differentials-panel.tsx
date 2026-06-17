/**
 * Per-team differentials / template / best-value panel (Phase 2.3).
 *
 * Server component. Renders the three buckets from `teamInsights`. The page
 * only mounts this for the viewer's OWN team, so it never exposes another
 * manager's roster; the ownership/ADP numbers it shows are pure cross-league
 * aggregates (no per-rival detail).
 */
import type { TeamInsights, RosterInsightPlayer } from "@/data/stats/differentials";

import { PlayerStatButton } from "../../player-stats-modal";

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function Row({
  p,
  metric,
}: {
  p: RosterInsightPlayer;
  metric: "owned" | "value";
}) {
  return (
    <li>
      <span className="pos-badge">{p.position}</span>{" "}
      <PlayerStatButton playerId={p.playerId} fullName={p.fullName} />{" "}
      <span className="field-hint">({p.nationalTeamName})</span>
      <span className="num diff-metric">
        {metric === "owned" ? (
          <>
            {pct(p.ownershipPct)} owned &middot; {p.pointsTotal} pts
          </>
        ) : (
          <>
            {p.valuePerAdp ?? "—"} pts/pick{" "}
            <span className="field-hint">
              ({p.pointsTotal} pts &middot; ADP {p.adp ?? "—"})
            </span>
          </>
        )}
      </span>
    </li>
  );
}

export function DifferentialsPanel({ insights }: { insights: TeamInsights }) {
  const { differentials, template, bestValue } = insights;
  const hasAny =
    differentials.length > 0 || template.length > 0 || bestValue.length > 0;

  return (
    <section className="panel diff-panel">
      <h2>Your edges</h2>
      <p className="subtitle">
        Cross-league context for your roster. Ownership % and ADP aggregate over
        every league&apos;s drafts &mdash; only your own players are shown here.
      </p>

      {!hasAny ? (
        <p className="field-hint">
          Not enough cross-league data yet &mdash; this fills in as other leagues
          draft and matches are scored.
        </p>
      ) : (
        <div className="diff-grid">
          <div>
            <h3>Differentials</h3>
            <p className="field-hint">Low-owned, scoring well.</p>
            {differentials.length === 0 ? (
              <p className="field-hint">None yet.</p>
            ) : (
              <ul className="diff-list">
                {differentials.map((p) => (
                  <Row key={p.playerId} p={p} metric="owned" />
                ))}
              </ul>
            )}
          </div>

          <div>
            <h3>Template</h3>
            <p className="field-hint">The players most rosters share.</p>
            {template.length === 0 ? (
              <p className="field-hint">None yet.</p>
            ) : (
              <ul className="diff-list">
                {template.map((p) => (
                  <Row key={p.playerId} p={p} metric="owned" />
                ))}
              </ul>
            )}
          </div>

          <div>
            <h3>Best value</h3>
            <p className="field-hint">Most points per draft slot (ADP).</p>
            {bestValue.length === 0 ? (
              <p className="field-hint">None yet.</p>
            ) : (
              <ul className="diff-list">
                {bestValue.map((p) => (
                  <Row key={p.playerId} p={p} metric="value" />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
