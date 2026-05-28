/**
 * Sign-out button for the site header.
 *
 * Clears the server session cookie via DELETE /api/auth/session, then sends
 * the browser to the login page. Firebase client state is left as-is - the
 * httpOnly session cookie is the sole source of truth server-side.
 */
"use client";

import { useState } from "react";

export default function SignOutButton() {
  const [busy, setBusy] = useState(false);

  async function handleSignOut(): Promise<void> {
    setBusy(true);
    try {
      await fetch("/api/auth/session", { method: "DELETE" });
    } finally {
      window.location.assign("/login");
    }
  }

  return (
    <button
      type="button"
      className="btn-link"
      onClick={() => void handleSignOut()}
      disabled={busy}
    >
      {busy ? "Signing out..." : "Sign out"}
    </button>
  );
}
