/**
 * The "Picks" log, most-recent first. Pure presentational.
 */
"use client";

import type { DraftPickLog } from "@/web/api-types";

interface PicksPanelProps {
  picks: DraftPickLog[];
}

export default function PicksPanel({ picks }: PicksPanelProps) {
  const recentPicks = [...picks].reverse();
  return (
    <section className="panel">
      <h2>Picks</h2>
      {recentPicks.length === 0 ? (
        <p className="field-hint">No picks yet.</p>
      ) : (
        <ul className="pick-log">
          {recentPicks.map((p) => (
            <li key={p.pickNumber}>
              <span className="field-hint">#{p.pickNumber}</span>{" "}
              <span className="pos-badge">{p.position}</span> {p.playerName}{" "}
              <span className="field-hint">
                &rarr; {p.teamName}
                {p.isAutopick ? " (auto)" : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
