/**
 * RenameTeamForm — inline form for changing the viewer's team name.
 */
"use client";

import { useState } from "react";

interface RenameTeamFormProps {
  leagueId: number;
  currentName: string;
}

export default function RenameTeamForm({
  leagueId,
  currentName,
}: RenameTeamFormProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave(): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed || trimmed === currentName) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/leagues/${leagueId}/team`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const body = (await res.json()) as {
        data?: { teamName: string };
        error?: { message?: string };
      };
      if (!res.ok) {
        throw new Error(body.error?.message ?? "could not rename team");
      }
      setValue(body.data?.teamName ?? trimmed);
      setEditing(false);
      // Refresh server data without a full navigation.
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not rename team");
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <span className="rename-team-row">
        <span className="rename-team-name">{value}</span>
        <button
          type="button"
          className="btn-link rename-team-btn"
          onClick={() => setEditing(true)}
        >
          Rename
        </button>
      </span>
    );
  }

  return (
    <span className="rename-team-row">
      <input
        className="rename-team-input"
        type="text"
        value={value}
        maxLength={50}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void handleSave();
          if (e.key === "Escape") setEditing(false);
        }}
      />
      <button
        type="button"
        className="btn-sm"
        disabled={busy || !value.trim()}
        onClick={() => void handleSave()}
      >
        {busy ? "Saving…" : "Save"}
      </button>
      <button
        type="button"
        className="btn-link"
        disabled={busy}
        onClick={() => { setEditing(false); setValue(currentName); }}
      >
        Cancel
      </button>
      {error ? <span className="error rename-error">{error}</span> : null}
    </span>
  );
}
