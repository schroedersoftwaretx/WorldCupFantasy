/**
 * The "Best available:" row of one top undrafted player per position. Renders
 * nothing until the board has loaded.
 */
"use client";

import type { DraftBoardPlayer } from "@/web/api-types";

import { bestAvailableByPosition } from "../types";

interface BestAvailableHintsProps {
  board: DraftBoardPlayer[] | null;
}

export default function BestAvailableHints({ board }: BestAvailableHintsProps) {
  if (!board) return null;
  return (
    <div className="best-available" aria-label="Best available by position">
      <span className="best-available-label">Best available:</span>
      {bestAvailableByPosition(board).map(({ position, player }) => (
        <span key={position} className="best-available-item">
          <span className="pos-badge">{position}</span> {player.fullName}
          {player.adp != null ? (
            <span className="field-hint"> ADP {player.adp}</span>
          ) : null}
        </span>
      ))}
    </div>
  );
}
