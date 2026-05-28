/**
 * Create-league form (client component, shown on the dashboard).
 *
 * POSTs to /api/leagues and, on success, navigates to the new league's
 * overview page.
 */
"use client";

import { useState, type FormEvent } from "react";

export default function CreateLeagueForm() {
  const [name, setName] = useState("");
  const [maxManagers, setMaxManagers] = useState("2");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/leagues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, maxManagers: Number(maxManagers) }),
      });
      const body = (await res.json().catch(() => null)) as
        | {
            data?: { leagueId: number };
            error?: { message?: string };
          }
        | null;
      if (!res.ok || !body?.data) {
        throw new Error(body?.error?.message ?? "could not create league");
      }
      window.location.assign(`/leagues/${body.data.leagueId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not create league");
      setBusy(false);
    }
  }

  return (
    <form className="form-card" onSubmit={(e) => void handleSubmit(e)}>
      <h2>Create a league</h2>
      <div className="field">
        <label htmlFor="league-name">League name</label>
        <input
          id="league-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Office World Cup"
          required
        />
      </div>
      <div className="field">
        <label htmlFor="league-size">Managers</label>
        <input
          id="league-size"
          type="number"
          min={2}
          max={24}
          value={maxManagers}
          onChange={(e) => setMaxManagers(e.target.value)}
        />
        <span className="field-hint">2 to 24. Two is fine for a friend.</span>
      </div>
      <button type="submit" className="btn" disabled={busy}>
        {busy ? "Creating..." : "Create league"}
      </button>
      {error ? <p className="error">{error}</p> : null}
    </form>
  );
}
