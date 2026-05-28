/**
 * Join button (client component) for the invite landing page.
 *
 * POSTs to the accept endpoint and, on success, navigates to the league.
 */
"use client";

import { useState } from "react";

export default function JoinButton({ token }: { token: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function join(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/invites/${encodeURIComponent(token)}/accept`,
        { method: "POST" },
      );
      const body = (await res.json().catch(() => null)) as
        | { data?: { leagueId: number }; error?: { message?: string } }
        | null;
      if (!res.ok || !body?.data) {
        throw new Error(body?.error?.message ?? "could not join the league");
      }
      window.location.assign(`/leagues/${body.data.leagueId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not join the league");
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn"
        onClick={() => void join()}
        disabled={busy}
      >
        {busy ? "Joining..." : "Join this league"}
      </button>
      {error ? <p className="error">{error}</p> : null}
    </>
  );
}
