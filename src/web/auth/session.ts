/**
 * Session cookie helpers (server-only).
 *
 * The browser signs in with Firebase and POSTs the resulting ID token; the
 * server exchanges it for a long-lived session cookie via the Admin SDK.
 * That cookie is httpOnly - JavaScript cannot read it - and is what every
 * later request presents. Server Components and route handlers verify it.
 */
import { getAdminAuth } from "../firebase/admin.js";
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from "./constants.js";

export { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS };

/** The identity claims carried by a verified session. */
export interface SessionClaims {
  /** Firebase UID - the stable manager identity. */
  uid: string;
  email: string;
  /** Display name; falls back to the email local-part. */
  name: string;
}

/**
 * Verify a Firebase ID token and exchange it for a session cookie value.
 * Throws if the token is invalid or Firebase Admin is not configured.
 */
export async function mintSessionCookie(idToken: string): Promise<string> {
  const auth = getAdminAuth();
  // Reject a junk / expired token before minting anything.
  await auth.verifyIdToken(idToken);
  return auth.createSessionCookie(idToken, {
    expiresIn: SESSION_MAX_AGE_SECONDS * 1000,
  });
}

/**
 * Verify a session cookie value and extract its identity claims. Returns
 * null for any invalid / expired cookie, and also when Firebase is not
 * configured - callers treat all of these uniformly as "not signed in".
 */
export async function readSessionClaims(
  cookieValue: string,
): Promise<SessionClaims | null> {
  try {
    const decoded = await getAdminAuth().verifySessionCookie(cookieValue);
    const email = typeof decoded.email === "string" ? decoded.email : "";
    const nameClaim = decoded["name"];
    const name =
      typeof nameClaim === "string" && nameClaim.trim().length > 0
        ? nameClaim
        : email.split("@")[0] || "Manager";
    return { uid: decoded.uid, email, name };
  } catch {
    return null;
  }
}

/** Cookie attributes shared by the set and clear variants. */
function cookieAttributes(maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${maxAgeSeconds}`;
}

/** Build a Set-Cookie header value that establishes the session. */
export function serializeSessionCookie(value: string): string {
  return `${SESSION_COOKIE}=${value}; ${cookieAttributes(SESSION_MAX_AGE_SECONDS)}`;
}

/** Build a Set-Cookie header value that clears the session. */
export function serializeClearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; ${cookieAttributes(0)}`;
}
