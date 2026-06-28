/**
 * The viewer's "Your team" panel: position counts, the drafted roster list,
 * and the best-lineup visualisation. Pure presentational.
 */
"use client";

import type { DraftPositionCounts, DraftRosterPlayer } from "@/web/api-types";

import { BestLineupViz } from "../best-lineup";
import { POSITIONS, POSITION_MAX } from "../types";

interface RosterPanelProps {
  counts: DraftPositionCounts;
  roster: DraftRosterPlayer[];
  rosterSize: number;
}

export default function RosterPanel({
  counts,
  roster,
  rosterSize,
}: RosterPanelProps) {
  return (
    <section className="panel">
      <h2>Your team</h2>
      <div className="counts-row">
        {POSITIONS.map((pos) => (
          <span key={pos} className="count-chip">
            {pos} {counts[pos]}/{POSITION_MAX[pos]}
          </span>
        ))}
        <span className="count-chip total">
          {roster.length}/{rosterSize}
        </span>
      </div>
      {roster.length === 0 ? (
        <p className="field-hint">No players drafted yet.</p>
      ) : (
        <ul className="roster-list">
          {roster.map((p) => (
            <li key={p.playerId}>
              <span className="pos-badge">{p.position}</span> {p.fullName}
            </li>
          ))}
        </ul>
      )}
      <BestLineupViz roster={roster} />
    </section>
  );
}
