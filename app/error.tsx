/**
 * Root error boundary (App Router).
 *
 * Catches uncaught errors thrown while rendering any route segment below the
 * root layout, replacing the raw Next error overlay / white screen with a
 * recoverable UI. `reset()` re-renders the segment so a transient failure
 * (e.g. a flaky data read) can recover without a full reload. Must be a Client
 * Component. Does NOT catch errors in the root layout itself — see
 * global-error.tsx for that.
 */
"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface to the console (and any attached error reporter) for diagnosis.
    console.error(error);
  }, [error]);

  return (
    <div className="boundary">
      <h1>Something went wrong</h1>
      <p className="subtitle">
        An unexpected error occurred while loading this page. You can try again,
        or head back to your leagues.
      </p>
      {error.digest ? (
        <p className="field-hint">Reference: {error.digest}</p>
      ) : null}
      <div className="boundary-actions">
        <button type="button" className="btn" onClick={() => reset()}>
          Try again
        </button>
        <Link href="/" className="btn btn-ghost">
          Go to your leagues
        </Link>
      </div>
    </div>
  );
}
