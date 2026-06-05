/**
 * Firebase client SDK (browser-only).
 *
 * Initializes the Firebase JS app from the NEXT_PUBLIC_FIREBASE_* config and
 * provides Google sign-in with a popup-first / redirect-fallback strategy:
 *
 *   Desktop / popup-capable browsers:
 *     signInWithPopup → immediate result → POST /api/auth/session
 *
 *   Mobile / popup-blocked browsers:
 *     signInWithPopup throws auth/popup-blocked or auth/cancelled-popup-request
 *     → falls back to signInWithRedirect
 *     → on return, getRedirectResult() in useRedirectResult() picks up the token
 *
 * authDomain must be the Firebase-managed domain (<project>.firebaseapp.com),
 * NOT your app's custom domain. Firebase hosts the /__/auth/handler callback
 * at that domain; pointing authDomain at your own app causes the OAuth
 * callback to reload your app, re-triggering the sign-in flow in a loop.
 */
"use client";

import { getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  GoogleAuthProvider,
  getAuth,
  getRedirectResult,
  signInWithPopup,
  signInWithRedirect,
  type Auth,
} from "firebase/auth";

export interface FirebaseClientConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
}

/** Read the client config from NEXT_PUBLIC_ env, or null if incomplete. */
export function readClientConfig(): FirebaseClientConfig | null {
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  const authDomain = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN;
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const appId = process.env.NEXT_PUBLIC_FIREBASE_APP_ID;
  if (!apiKey || !authDomain || !projectId || !appId) return null;
  return { apiKey, authDomain, projectId, appId };
}

export function isClientConfigured(): boolean {
  return readClientConfig() !== null;
}

let cachedAuth: Auth | null = null;

export function getClientAuth(): Auth {
  if (cachedAuth) return cachedAuth;
  const config = readClientConfig();
  if (!config) {
    throw new Error("Firebase client is not configured - see FIREBASE_SETUP.md");
  }
  const app: FirebaseApp = getApps()[0] ?? initializeApp(config);
  cachedAuth = getAuth(app);
  return cachedAuth;
}

/** Error codes from Firebase that mean the popup was blocked or closed. */
const POPUP_BLOCKED_CODES = new Set([
  "auth/popup-blocked",
  "auth/cancelled-popup-request",
  "auth/popup-closed-by-user",
]);

/**
 * Sign in with Google.
 *
 * Returns an ID token string if sign-in completed synchronously (popup).
 * Returns null if a redirect was initiated — the caller should wait for
 * the page to return from the redirect and call checkRedirectResult().
 */
export async function signInWithGoogle(): Promise<string | null> {
  const auth = getClientAuth();
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  try {
    const result = await signInWithPopup(auth, provider);
    return result.user.getIdToken();
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? "";
    if (POPUP_BLOCKED_CODES.has(code)) {
      // Popup was blocked (common on mobile) — fall back to redirect flow.
      await signInWithRedirect(auth, provider);
      return null; // page will redirect; caller should not proceed
    }
    throw err;
  }
}

/**
 * Check if we're returning from a redirect sign-in flow.
 * Call this on the login page mount. Returns an ID token if a redirect
 * result is pending, or null if not (normal page load / popup flow).
 */
export async function checkRedirectResult(): Promise<string | null> {
  try {
    const auth = getClientAuth();
    const result = await getRedirectResult(auth);
    if (!result) return null;
    return result.user.getIdToken();
  } catch {
    // Not a redirect return or redirect was cancelled — ignore.
    return null;
  }
}
