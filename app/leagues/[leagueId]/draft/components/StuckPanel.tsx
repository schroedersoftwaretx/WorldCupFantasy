/**
 * The "Stuck?" helper panel: process overdue timeouts, plus an owner-only
 * force-autopick action. Presentational; the parent owns both actions.
 */
"use client";

interface StuckPanelProps {
  isOwner: boolean;
  actionBusy: boolean;
  onProcessTimeouts: () => void;
  onForcePick: () => void;
}

export default function StuckPanel({
  isOwner,
  actionBusy,
  onProcessTimeouts,
  onForcePick,
}: StuckPanelProps) {
  return (
    <section className="panel">
      <h2>Stuck?</h2>
      <p className="field-hint">
        If a pick is past its deadline, process it now instead of
        waiting for the scheduled tick.
      </p>
      <button
        type="button"
        className="btn-link"
        disabled={actionBusy}
        onClick={onProcessTimeouts}
      >
        Process timeouts
      </button>
      {isOwner ? (
        <>
          <p className="field-hint" style={{ marginTop: "0.75rem" }}>
            Skip the current pick immediately and autopick for them,
            even if the timer hasn&apos;t expired.
          </p>
          <button
            type="button"
            className="btn-link btn-link-warn"
            disabled={actionBusy}
            onClick={onForcePick}
          >
            Force autopick now
          </button>
        </>
      ) : null}
    </section>
  );
}
