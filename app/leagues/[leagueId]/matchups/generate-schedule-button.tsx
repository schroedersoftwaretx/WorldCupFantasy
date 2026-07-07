/**
 * GenerateScheduleButton - owner-only action that creates (or regenerates)
 * the head-to-head round-robin schedule via POST /api/leagues/:id/h2h/schedule.
 */
"use client";

import { useState } from "react";

interface GenerateScheduleButtonProps {
  leagueId: number;
  /** True when a schedule already exists (button reads "Regenerate"). */
  scheduled: boolean;
}

export default function GenerateScheduleButton({
  leagueId,
  scheduled,
}: GenerateScheduleButtonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/leagues/${leagueId}/h2h/schedule`, {
        method: "POST",
      });
      const body = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) {
        throw new Error(body.error?.message ?? "could not generate schedule");
      }
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not generate schedule");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="generate-schedule">
      <button
        type="button"
        className="btn-sm"
        disabled={busy}
        onClick={() => void handleClick()}
      >
        {busy
          ? "Working…"
          : scheduled
            ? "Regenerate schedule"
            : "Generate schedule"}
      </button>
      {error ? <span className="error"> {error}</span> : null}
    </span>
  );
}
