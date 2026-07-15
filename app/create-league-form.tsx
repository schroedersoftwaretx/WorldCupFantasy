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
  const [format, setFormat] = useState<"BEST_BALL" | "SET_LINEUP">("BEST_BALL");
  const [formationSet, setFormationSet] = useState<"CLASSIC" | "EXPANDED">(
    "CLASSIC",
  );
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
        body: JSON.stringify({
          name,
          maxManagers: Number(maxManagers),
          format,
          formationSet,
        }),
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
        <label htmlFor="league-format">Format</label>
        <select
          id="league-format"
          value={format}
          onChange={(e) =>
            setFormat(e.target.value === "SET_LINEUP" ? "SET_LINEUP" : "BEST_BALL")
          }
        >
          <option value="BEST_BALL">Best ball — no lineups, best XI counts</option>
          <option value="SET_LINEUP">Set lineup — submit an XI before each round</option>
        </select>
        <span className="field-hint">
          Best ball scores your optimal XI automatically each round. Set
          lineup locks your submitted XI (captain doubles) at first kickoff.
        </span>
      </div>
      <div className="field">
        <label htmlFor="league-formations">Formations</label>
        <select
          id="league-formations"
          value={formationSet}
          onChange={(e) =>
            setFormationSet(e.target.value === "EXPANDED" ? "EXPANDED" : "CLASSIC")
          }
        >
          <option value="CLASSIC">
            Classic - 4-3-3, 4-4-2, 5-2-3, 5-3-2
          </option>
          <option value="EXPANDED">
            Expanded - adds 3-4-3, 3-5-2, 4-5-1, 5-4-1
          </option>
        </select>
        <span className="field-hint">
          Which XI shapes are legal - for submitted lineups and the best-ball
          optimizer alike.
        </span>
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
