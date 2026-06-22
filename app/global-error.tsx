/**
 * Global error boundary (App Router).
 *
 * The last line of defence: catches errors thrown by the ROOT layout itself
 * (which app/error.tsx cannot, since it renders inside that layout). It must
 * render its own <html> and <body>, and because it replaces the root layout the
 * app's global stylesheet is not guaranteed to apply — so its few styles are
 * inlined. Client Component.
 */
"use client";

import { useEffect } from "react";

export default function GlobalError({
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
    <html lang="en">
      <body
        style={{
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
          color: "#1a1a1a",
          background: "#fafafa",
          margin: 0,
        }}
      >
        <main
          style={{
            maxWidth: "32rem",
            margin: "3rem auto",
            padding: "1.5rem",
            textAlign: "center",
          }}
        >
          <h1 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>
            Something went wrong
          </h1>
          <p style={{ color: "#666" }}>
            A critical error occurred. Please reload the page.
          </p>
          {error.digest ? (
            <p style={{ color: "#666", fontSize: "0.8rem" }}>
              Reference: {error.digest}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => reset()}
            style={{
              marginTop: "1.25rem",
              background: "#1f6feb",
              color: "#fff",
              border: "none",
              borderRadius: "6px",
              padding: "0.55rem 1.1rem",
              fontSize: "0.95rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </main>
      </body>
    </html>
  );
}
