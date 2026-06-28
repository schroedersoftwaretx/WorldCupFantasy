/**
 * The "set up the draft" panel shown when no draft room exists yet (status
 * NONE). Presentational: the parent owns the timer input value and the create
 * action.
 */
"use client";

interface CreateDraftPanelProps {
  isOwner: boolean;
  actionBusy: boolean;
  timerInput: string;
  onTimerInputChange: (value: string) => void;
  onCreate: () => void;
}

export default function CreateDraftPanel({
  isOwner,
  actionBusy,
  timerInput,
  onTimerInputChange,
  onCreate,
}: CreateDraftPanelProps) {
  if (!isOwner) {
    return (
      <p className="notice">
        The league owner has not set up the draft yet.
      </p>
    );
  }
  return (
    <div className="form-card">
      <h2>Set up the draft</h2>
      <p>Create the draft room, then start it once everyone has joined.</p>
      <div className="field">
        <label htmlFor="timer">Pick timer</label>
        <div className="timer-presets">
          {[
            { label: "15 min", hours: 0.25 },
            { label: "30 min", hours: 0.5 },
            { label: "1 hr",   hours: 1 },
            { label: "2 hr",   hours: 2 },
            { label: "6 hr",   hours: 6 },
            { label: "12 hr",  hours: 12 },
            { label: "24 hr",  hours: 24 },
            { label: "48 hr",  hours: 48 },
          ].map(({ label, hours }) => (
            <button
              key={hours}
              type="button"
              className={
                Number(timerInput) === hours
                  ? "timer-preset timer-preset-active"
                  : "timer-preset"
              }
              onClick={() => onTimerInputChange(String(hours))}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          id="timer"
          type="number"
          min={0}
          max={168}
          step={0.25}
          value={timerInput}
          onChange={(e) => onTimerInputChange(e.target.value)}
        />
        <span className="field-hint">
          Hours per pick — 12 hr is typical for async drafts, 15–30 min
          for a draft done in one sitting. Set 0 to disable the timer.
        </span>
      </div>
      <button
        type="button"
        className="btn"
        disabled={actionBusy}
        onClick={onCreate}
      >
        {actionBusy ? "Creating..." : "Create draft"}
      </button>
    </div>
  );
}
