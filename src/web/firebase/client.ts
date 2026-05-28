/**
 * Firebase client SDK (browser-only).
 *
 * Initializes the Firebase JS app from the NEXT_PUBLIC_FIREBASE_* config and
 * provides Google sign-in. These values are public by design - the Firebase
 * client config is not a secret; access control is enforced server-side by
 * verifying the resulting ID token with the Admin SDK.
 */
"use client";

import { getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  GoogleAuthProvider,
  getAuth,
  signInWithPopup,
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
  // Dot access: Next inlines NEXT_PUBLIC_* statically into the browser bundle.
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  const authDomain = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN;
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const appId = process.env.NEXT_PUBLIC_FIREBASE_APP_ID;
  if (!apiKey || !authDomain || !projectId || !appId) return null;
  return { apiKey, authDomain, projectId, appId };
}

/** True when the browser has a complete Firebase client config. */
export function isClientConfigured(): boolean {
  return readClientConfig() !== null;
}

let cachedAuth: Auth | null = null;

function getClientAuth(): Auth {
  if (cachedAuth) return cachedAuth;
  const config = readClientConfig();
  if (!config) {
    throw new Error("Firebase client is not configured - see FIREBASE_SETUP.md");
  }
  const app: FirebaseApp = getApps()[0] ?? initializeApp(config);
  cachedAuth = getAuth(app);
  return cachedAuth;
}

/**
 * Open the Google sign-in popup and return a fresh Firebase ID token. The
 * caller POSTs that token to /api/auth/session to establish a session.
 */
export async function signInWithGoogle(): Promise<string> {
  const auth = getClientAuth();
  const provider = new GoogleAuthProvider();
  const result = await signInWithPopup(auth, provider);
  return result.user.getIdToken();
}
