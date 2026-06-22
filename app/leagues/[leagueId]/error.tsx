/**
 * Error boundary for the league segment (overview, standings, draft, roster,
 * scoring, settings, …). Keeps the user in context with a recover action and a
 * route back to their leagues, instead of bubbling up to the root boundary.
 */
"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function LeagueError({
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
      <h1>Couldn&apos;t load this league</h1>
      <p className="subtitle">
        Something went wrong while loading this page. Try again, or go back to
        your leagues.
      </p>
      {error.digest ? (
        <p className="field-hint">Reference: {error.digest}</p>
      ) : null}
      <div className="boundary-actions">
        <button type="button" className="btn" onClick={() => reset()}>
          Try again
        </button>
        <Link href="/" className="btn btn-ghost">
          Your leagues
        </Link>
      </div>
    </div>
  );
}
