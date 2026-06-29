/**
 * Resolving the current signed-in manager (server-only).
 *
 * `resolveUserFromCookie` is the framework-free core: a cookie value in, the
 * manager out. `getCurrentUser` is the Server-Component wrapper that reads
 * the cookie via next/headers; `requireUserForRoute` is the route-handler
 * wrapper that reads it from the request and throws a 401 envelope.
 *
 * Resolving a session find-or-creates the manager row by Firebase UID:
 * `createManager` is already an idempotent upsert keyed on firebase_uid, so
 * a first-ever sign-in seamlessly provisions the manager.
 */
import { cookies } from "next/headers";
import { cache } from "react";

import type { ManagerRow } from "../../data/db/schema.js";
import { createManager } from "../../data/league/service.js";
import { HttpError } from "../api.js";
import { getDb } from "../db.js";
import { SESSION_COOKIE } from "./constants.js";
import { readSessionClaims, type SessionClaims } from "./session.js";
import { logger } from "../../log.js";

export interface CurrentUser {
  manager: ManagerRow;
  claims: SessionClaims;
}

/**
 * Framework-free core: turn a raw session cookie value into the current
 * user, or null. Exported so it can be exercised without a Next request scope.
 */
export async function resolveUserFromCookie(
  cookieValue: string | undefined,
): Promise<CurrentUser | null> {
  if (!cookieValue) return null;
  const claims = await readSessionClaims(cookieValue);
  if (!claims) return null;
  try {
    const manager = await createManager(getDb(), {
      firebaseUid: claims.uid,
      displayName: claims.name,
      email: claims.email,
    });
    return { manager, claims };
  } catch (e) {
    // Treat a DB hiccup as "not signed in" rather than crashing every page.
    logger.error("[auth] manager lookup/provisioning failed", { err: e });
    return null;
  }
}

/**
 * The current user for a Server Component / page, or null. Memoized per
 * render with React `cache` so the layout and the page share one lookup.
 */
export const getCurrentUser = cache(
  async (): Promise<CurrentUser | null> => {
    const store = await cookies();
    return resolveUserFromCookie(store.get(SESSION_COOKIE)?.value);
  },
);

/** Parse a Cookie request header into a name -> value map. */
function parseCookieHeader(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out.set(name, value);
  }
  return out;
}

/**
 * The current user for a route handler. Reads the session cookie straight
 * from the request and throws a 401 HttpError if there is no valid session.
 */
export async function requireUserForRoute(
  request: Request,
): Promise<CurrentUser> {
  const cookieValue = parseCookieHeader(request.headers.get("cookie")).get(
    SESSION_COOKIE,
  );
  const user = await resolveUserFromCookie(cookieValue);
  if (!user) {
    throw new HttpError("sign-in required", "UNAUTHENTICATED", 401);
  }
  return user;
}
