/**
 * Invite panel (client component) - shown on the league overview to owners.
 *
 * Generates an invite link via the API and offers a one-click copy.
 */
"use client";

import { useState } from "react";

export default function InvitePanel({ leagueId }: { leagueId: number }) {
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/leagues/${leagueId}/invites`, {
        method: "POST",
      });
      const body = (await res.json().catch(() => null)) as
        | { data?: { path: string }; error?: { message?: string } }
        | null;
      if (!res.ok || !body?.data) {
        throw new Error(body?.error?.message ?? "could not create an invite");
      }
      // Prefer NEXT_PUBLIC_APP_URL so the link always points to the
      // production deployment, not whichever preview URL was used to generate it.
      const origin =
        process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
        window.location.origin;
      setLink(origin + body.data.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not create an invite");
    } finally {
      setBusy(false);
    }
  }

  async function copy(): Promise<void> {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable; the link is still selectable.
    }
  }

  return (
    <section className="panel">
      <h2>Invite a manager</h2>
      <p>
        Generate a link and send it to a friend. Anyone with the link can join
        until the league is full.
      </p>
      {link ? (
        <div className="invite-link-row">
          <input
            className="invite-link-input"
            type="text"
            readOnly
            value={link}
            onFocus={(e) => e.currentTarget.select()}
          />
          <button type="button" className="btn" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="btn"
          onClick={() => void generate()}
          disabled={busy}
        >
          {busy ? "Generating..." : "Generate invite link"}
        </button>
      )}
      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}
