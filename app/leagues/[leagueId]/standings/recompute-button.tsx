"use client";
/**
 * Owner-only "Recompute scores" button (W5).
 *
 * Posts to the manual recompute endpoint and shows the result inline.
 * After a successful recompute it triggers a full page refresh so the
 * updated standings render without a manual reload.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

interface Props {
  leagueId: number;
}

export default function RecomputeButton({ leagueId }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  async function handleClick() {
    setBusy(true);
    setResult(null);
    setIsError(false);
    try {
      const res = await fetch(
        `/api/leagues/${leagueId}/standings/recompute`,
        { method: "POST" },
      );
      const json = await res.json();
      if (json.ok) {
        const d = json.data as { inserted: number; updated: number; skipped: number };
        setResult(
          `Done — ${d.inserted} new, ${d.updated} updated, ${d.skipped} unchanged.`,
        );
        router.refresh();
      } else {
        setIsError(true);
        setResult(json.error?.message ?? "Recompute failed.");
      }
    } catch (e) {
      setIsError(true);
      setResult(e instanceof Error ? e.message : "Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="recompute-action">
      <button className="btn btn-sm" onClick={handleClick} disabled={busy}>
        {busy ? "Recomputing…" : "Recompute scores"}
      </button>
      {result && (
        <span className={isError ? "recompute-error" : "recompute-ok"}>
          {result}
        </span>
      )}
    </span>
  );
}
