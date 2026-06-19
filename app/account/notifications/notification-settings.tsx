/**
 * Notification preferences settings (client component).
 *
 * A grid of per-category, per-channel toggles. Each toggle PUTs the single
 * (category, channel) change to /api/account/notifications and re-renders from
 * the returned matrix, so the UI always reflects server truth.
 */
"use client";

import { useState } from "react";

type Channel = "IN_APP" | "EMAIL";
type Matrix = Record<string, Record<Channel, boolean>>;

interface CategoryMeta {
  key: string;
  label: string;
  description: string;
}

interface Props {
  initial: Matrix;
  categories: CategoryMeta[];
  channels: { key: Channel; label: string }[];
}

interface Envelope {
  data?: { preferences?: Matrix };
  error?: { message?: string };
}

export default function NotificationSettings({
  initial,
  categories,
  channels,
}: Props) {
  const [matrix, setMatrix] = useState<Matrix>(initial);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(category: string, channel: Channel, next: boolean) {
    const key = `${category}:${channel}`;
    setBusyKey(key);
    setError(null);
    // Optimistic update; reconciled from the server response below.
    setMatrix((m) => ({
      ...m,
      [category]: { ...m[category]!, [channel]: next },
    }));
    try {
      const res = await fetch("/api/account/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, channel, enabled: next }),
      });
      const body = (await res.json().catch(() => null)) as Envelope | null;
      if (!res.ok || !body?.data?.preferences) {
        throw new Error(body?.error?.message ?? "could not save your preference");
      }
      setMatrix(body.data.preferences);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not save your preference");
      // Roll back the optimistic change.
      setMatrix((m) => ({
        ...m,
        [category]: { ...m[category]!, [channel]: !next },
      }));
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="panel">
      {error ? <p className="error">{error}</p> : null}
      <p className="field-hint">
        Choose how you want to be notified for each kind of event. Off means you
        won&apos;t get that notification on that channel.
      </p>
      <div className="prefs-scroll">
        <table className="prefs-table">
          <thead>
            <tr>
              <th scope="col">Event</th>
              {channels.map((c) => (
                <th key={c.key} scope="col" className="num">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {categories.map((cat) => (
              <tr key={cat.key}>
                <th scope="row" className="prefs-row-head">
                  <span className="prefs-label">{cat.label}</span>
                  <span className="field-hint">{cat.description}</span>
                </th>
                {channels.map((c) => {
                  const on = matrix[cat.key]?.[c.key] ?? true;
                  const key = `${cat.key}:${c.key}`;
                  return (
                    <td key={c.key} className="num">
                      <label className="pref-toggle">
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={busyKey === key}
                          onChange={(e) => void toggle(cat.key, c.key, e.target.checked)}
                          aria-label={`${cat.label} via ${c.label}`}
                        />
                        <span className="pref-toggle-text">
                          {on ? "On" : "Off"}
                        </span>
                      </label>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
