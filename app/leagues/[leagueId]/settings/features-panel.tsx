/**
 * FeaturesPanel - owner toggles for per-league feature flags (Phase 0).
 *
 * Client component. Renders a switch per flag and PUTs each change to
 * /api/leagues/[id]/flags, reflecting the server's returned state. The flag
 * keys/labels are duplicated here (rather than imported from the data-layer
 * helper, which pulls in DB code) so this stays a pure client bundle.
 */
"use client";

import { useState } from "react";

/** Keep in sync with FLAGS in src/data/league/feature-flags.ts. */
const FLAG_LABELS: ReadonlyArray<{ key: string; label: string; hint: string }> =
  [
    { key: "stats_hub", label: "Stats Hub", hint: "Tournament leaderboards and records." },
    { key: "chat", label: "League chat", hint: "Chat, reactions, activity feed." },
    { key: "head_to_head", label: "Head-to-head", hint: "Weekly matchups and rivalries." },
    { key: "bracket", label: "Bracket predictor", hint: "Knockout bracket side-game." },
    { key: "survivor", label: "Survivor pool", hint: "Last-team-standing side-game." },
    { key: "chips", label: "Strategy chips", hint: "Per-stage captain and chips." },
    {
      key: "transactions",
      label: "Transactions",
      hint: "Free agency, waiver claims, and trades.",
    },
    { key: "awards", label: "Awards", hint: "Golden Boot and tournament awards." },
  ];

interface FeaturesPanelProps {
  leagueId: number;
  initial: Record<string, boolean>;
}

interface FlagsResponse {
  data?: { flags: Record<string, { enabled: boolean }> };
  error?: { message?: string };
}

export default function FeaturesPanel({
  leagueId,
  initial,
}: FeaturesPanelProps) {
  const [flags, setFlags] = useState<Record<string, boolean>>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(key: string, next: boolean): Promise<void> {
    setBusy(key);
    setError(null);
    // Optimistic update; reconcile with the server response.
    setFlags((f) => ({ ...f, [key]: next }));
    try {
      const res = await fetch(`/api/leagues/${leagueId}/flags`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flag: key, enabled: next }),
      });
      const body = (await res.json()) as FlagsResponse;
      if (!res.ok || !body.data) {
        throw new Error(body.error?.message ?? "could not update feature");
      }
      const reconciled: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(body.data.flags)) {
        reconciled[k] = v.enabled;
      }
      setFlags(reconciled);
    } catch (e) {
      // Roll back the optimistic change.
      setFlags((f) => ({ ...f, [key]: !next }));
      setError(e instanceof Error ? e.message : "could not update feature");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="features-panel">
      {error ? <p className="error">{error}</p> : null}
      <ul className="features-list">
        {FLAG_LABELS.map((f) => (
          <li key={f.key} className="features-row">
            <label className="features-label">
              <input
                type="checkbox"
                checked={flags[f.key] ?? false}
                disabled={busy === f.key}
                onChange={(e) => void toggle(f.key, e.target.checked)}
              />
              <span className="features-name">{f.label}</span>
              <span className="features-hint">{f.hint}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
