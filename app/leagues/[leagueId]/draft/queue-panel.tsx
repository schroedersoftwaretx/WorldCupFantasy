/**
 * Draft pick-queue panel (client, presentational).
 *
 * Renders the viewer's ranked targets with move-up / move-down / remove
 * controls. All mutations are owned by the parent <DraftRoom>, which POSTs to
 * /api/leagues/[id]/draft/queue and feeds the fresh queue back down here.
 */
"use client";

import type { QueueEntry } from "@/data/draft/queue";

interface Props {
  queue: QueueEntry[];
  busy: boolean;
  onReorder: (orderedPlayerIds: number[]) => void;
  onRemove: (playerId: number) => void;
}

export default function QueuePanel({ queue, busy, onReorder, onRemove }: Props) {
  function move(index: number, delta: number) {
    const next = queue.map((e) => e.playerId);
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    onReorder(next);
  }

  return (
    <section className="panel" aria-labelledby="queue-heading">
      <h2 id="queue-heading">Your pick queue</h2>
      <p className="field-hint">
        Rank your targets. If your pick times out, the draft auto-picks the
        highest player here that&apos;s still available and fits your roster
        &mdash; otherwise it uses the default rankings.
      </p>
      {queue.length === 0 ? (
        <p className="field-hint">
          Queue is empty. Use &ldquo;+ Queue&rdquo; on the player board to add
          targets.
        </p>
      ) : (
        <ol className="queue-list">
          {queue.map((e, i) => (
            <li
              key={e.playerId}
              className={e.available ? "queue-item" : "queue-item taken"}
            >
              <span className="queue-rank" aria-hidden="true">
                {i + 1}
              </span>
              <span className="pos-badge">{e.position}</span>
              <span className="queue-name">
                {e.fullName}
                {!e.available ? (
                  <span className="field-hint"> (drafted)</span>
                ) : null}
              </span>
              <span className="queue-controls">
                <button
                  type="button"
                  className="btn-icon"
                  disabled={busy || i === 0}
                  aria-label={`Move ${e.fullName} up`}
                  onClick={() => move(i, -1)}
                >
                  &uarr;
                </button>
                <button
                  type="button"
                  className="btn-icon"
                  disabled={busy || i === queue.length - 1}
                  aria-label={`Move ${e.fullName} down`}
                  onClick={() => move(i, 1)}
                >
                  &darr;
                </button>
                <button
                  type="button"
                  className="btn-icon btn-icon-warn"
                  disabled={busy}
                  aria-label={`Remove ${e.fullName} from queue`}
                  onClick={() => onRemove(e.playerId)}
                >
                  &times;
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
