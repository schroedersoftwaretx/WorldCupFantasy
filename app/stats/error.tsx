/**
 * Error boundary for the public Stats Hub segment. Recoverable, with a link
 * back to the hub home.
 */
"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function StatsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="boundary">
      <h1>Couldn&apos;t load stats</h1>
      <p className="subtitle">
        Something went wrong loading this page. Try again, or return to the
        Stats Hub.
      </p>
      {error.digest ? (
        <p className="field-hint">Reference: {error.digest}</p>
      ) : null}
      <div className="boundary-actions">
        <button type="button" className="btn" onClick={() => reset()}>
          Try again
        </button>
        <Link href="/stats" className="btn btn-ghost">
          Stats Hub
        </Link>
      </div>
    </div>
  );
}
