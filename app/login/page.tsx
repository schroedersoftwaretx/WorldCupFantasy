/**
 * Sign-in page.
 *
 * A client component: the Google sign-in popup is browser-only. On success
 * it POSTs the Firebase ID token to /api/auth/session (which sets the
 * httpOnly session cookie) and then navigates to the `?next=` path the user
 * was originally headed for (validated by `safeNextPath`), or to "/".
 */
"use client";

import { useState } from "react";

import { safeNextPath } from "@/web/auth/next-path";
import { isClientConfigured, signInWithGoogle } from "@/web/firebase/client";

export default function LoginPage() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configured = isClientConfigured();

  async function handleSignIn(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const idToken = await signInWithGoogle();
      const res = await fetch("/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        throw new Error(body?.error?.message ?? "sign-in failed");
      }
      const next = safeNextPath(
        new URLSearchParams(window.location.search).get("next"),
      );
      window.location.assign(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "sign-in failed");
      setBusy(false);
    }
  }

  return (
    <div className="auth-card">
      <h1>Sign in</h1>
      <p className="subtitle">
        World Cup Fantasy is a private league. Sign in with Google to continue.
      </p>
      {configured ? (
        <>
          <button
            type="button"
            className="btn"
            onClick={() => void handleSignIn()}
            disabled={busy}
          >
            {busy ? "Signing in..." : "Sign in with Google"}
          </button>
          {error ? <p className="error">{error}</p> : null}
        </>
      ) : (
        <p className="error">
          Firebase is not configured yet. Add the NEXT_PUBLIC_FIREBASE_* values
          to your .env file &mdash; see FIREBASE_SETUP.md.
        </p>
      )}
    </div>
  );
}
