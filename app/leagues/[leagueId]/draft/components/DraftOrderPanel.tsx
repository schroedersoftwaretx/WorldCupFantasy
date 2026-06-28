/**
 * The frozen snake "Draft order" list. Highlights the team on the clock while
 * the draft is in progress. Renders nothing until an order exists.
 */
"use client";

import type { DraftOrderSlot } from "@/web/api-types";

interface DraftOrderPanelProps {
  order: DraftOrderSlot[];
  inProgress: boolean;
  onClockTeamId: number | null;
}

export default function DraftOrderPanel({
  order,
  inProgress,
  onClockTeamId,
}: DraftOrderPanelProps) {
  if (order.length === 0) return null;
  return (
    <section className="panel">
      <h2>Draft order</h2>
      <ol className="order-list">
        {order.map((o) => (
          <li
            key={o.slot}
            className={
              inProgress && o.fantasyTeamId === onClockTeamId ? "on-clock" : ""
            }
          >
            {o.teamName}{" "}
            <span className="field-hint">({o.managerName})</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
