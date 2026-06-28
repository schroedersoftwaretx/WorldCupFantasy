/**
 * The "start the draft" view shown once the room exists but hasn't begun
 * (status PENDING). Presentational: the parent owns the start action.
 */
"use client";

interface StartDraftPanelProps {
  isOwner: boolean;
  actionBusy: boolean;
  teamCount: number;
  pickTimerHours: number | null;
  onStart: () => void;
}

export default function StartDraftPanel({
  isOwner,
  actionBusy,
  teamCount,
  pickTimerHours,
  onStart,
}: StartDraftPanelProps) {
  const enough = teamCount >= 2;
  return (
    <>
      <p className="subtitle">
        The draft room is ready &mdash; {teamCount}{" "}
        {teamCount === 1 ? "manager has" : "managers have"} joined.
        Pick timer: {pickTimerHours}h.
      </p>
      {isOwner ? (
        <div className="panel">
          <h2>Start the draft</h2>
          {enough ? (
            <p>
              Starting freezes a random snake order and puts pick 1 on the
              clock.
            </p>
          ) : (
            <p className="error">
              A draft needs at least 2 managers. Invite another from the
              league page first.
            </p>
          )}
          <button
            type="button"
            className="btn"
            disabled={actionBusy || !enough}
            onClick={onStart}
          >
            {actionBusy ? "Starting..." : "Start draft"}
          </button>
        </div>
      ) : (
        <p className="notice">
          Waiting for the league owner to start the draft.
        </p>
      )}
    </>
  );
}
