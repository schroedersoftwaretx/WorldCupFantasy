/**
 * Sign-in page.
 *
 * Supports two flows:
 *   Popup flow  — signInWithGoogle() returns a token directly (desktop).
 *   Redirect flow — signInWithGoogle() initiates a redirect (mobile/blocked);
 *                   on return, checkRedirectResult() picks up the pending token.
 *
 * On success either way, POSTs the ID token to /api/auth/session to set the
 * httpOnly session cookie, then navigates to ?next= or "/".
 */
"use client";

import { useEffect, useState } from "react";

import { safeNextPath } from "@/web/auth/next-path";
import {
  checkRedirectResult,
  isClientConfigured,
  signInWithGoogle,
} from "@/web/firebase/client";

export default function LoginPage() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configured = isClientConfigured();

  // On mount: check whether we're returning from a redirect sign-in.
  useEffect(() => {
    if (!configured) return;
    // Drain any stale redirect state from previous sign-in attempts.
    // signInWithGoogle now uses popup-only, so this will almost always be
    // null — but clearing it prevents stale "missing initial state" errors.
    checkRedirectResult()
      .then((idToken) => {
        if (idToken) return completeSignIn(idToken);
      })
      .catch(() => { /* stale state — ignore */ })
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSignIn(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const idToken = await signInWithGoogle();
      await completeSignIn(idToken);
    } catch (e) {
      setError(e instanceof Error ? e.message : "sign-in failed");
      setBusy(false);
    }
  }

  async function completeSignIn(idToken: string): Promise<void> {
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
