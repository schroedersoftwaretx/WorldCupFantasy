/**
 * POST   /api/auth/session  - exchange a Firebase ID token for a session cookie.
 * DELETE /api/auth/session  - clear the session cookie (sign out).
 *
 * The browser obtains the ID token from the Firebase client SDK (Google
 * popup) and POSTs it here. The server verifies it, mints a long-lived
 * httpOnly session cookie, and - on a first-ever sign-in - provisions the
 * manager row.
 */
import { err, ok } from "@/web/api";
import type { AuthSessionData } from "@/web/api-types";
import { resolveUserFromCookie } from "@/web/auth/current-user";
import {
  mintSessionCookie,
  serializeClearedSessionCookie,
  serializeSessionCookie,
} from "@/web/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let idToken: unknown;
  try {
    const body: unknown = await request.json();
    idToken = (body as { idToken?: unknown }).idToken;
  } catch {
    return err("request body must be JSON", "BAD_REQUEST", 400);
  }
  if (typeof idToken !== "string" || idToken.length === 0) {
    return err("missing idToken", "BAD_REQUEST", 400);
  }

  let cookieValue: string;
  try {
    cookieValue = await mintSessionCookie(idToken);
  } catch (e) {
    // Surface the real cause - Firebase's messages (bad key, project
    // mismatch, expired token) are diagnostic and contain no secrets.
    console.error("[auth] session mint failed:", e);
    const detail = e instanceof Error ? e.message : String(e);
    return err(`could not verify sign-in: ${detail}`, "AUTH_FAILED", 401);
  }

  // Resolve (and, on a first sign-in, provision) the manager. A failure here
  // does not block the session - the cookie is still set and the next page
  // load retries provisioning.
  let data: AuthSessionData = { managerId: null, displayName: null };
  try {
    const user = await resolveUserFromCookie(cookieValue);
    if (user) {
      data = {
        managerId: user.manager.id,
        displayName: user.manager.displayName,
      };
    }
  } catch (e) {
    console.error("[auth] manager provisioning failed:", e);
  }

  return ok(data, 200, { "Set-Cookie": serializeSessionCookie(cookieValue) });
}

export function DELETE(): Response {
  return ok({ signedOut: true }, 200, {
    "Set-Cookie": serializeClearedSessionCookie(),
  });
}
