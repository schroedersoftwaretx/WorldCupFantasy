/**
 * Admin gating for the manual stat editor.
 *
 * stat_line is GLOBAL (not per-league): editing a player's line affects every
 * league's standings. So the editor is gated on a small operator allowlist
 * rather than per-league ownership. Set ADMIN_EMAILS to a comma-separated
 * list of manager emails (case-insensitive). When unset, no one is admin in
 * production; in development (NODE_ENV !== "production") any signed-in user is
 * treated as admin so the page is usable locally without extra config.
 */
import type { CurrentUser } from "./current-user.js";
import { getCurrentUser, requireUserForRoute } from "./current-user.js";
import { HttpError } from "../api.js";

/** True when `email` is on the ADMIN_EMAILS allowlist. */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const raw = process.env["ADMIN_EMAILS"];
  if (!raw) return process.env["NODE_ENV"] !== "production";
  const allow = raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allow.includes(email.trim().toLowerCase());
}

/** Route-handler guard: 401 if not signed in, 403 if not an admin. */
export async function requireAdminForRoute(request: Request): Promise<CurrentUser> {
  const user = await requireUserForRoute(request);
  if (!isAdminEmail(user.manager.email)) {
    throw new HttpError("admin access required", "FORBIDDEN", 403);
  }
  return user;
}

/** Server-Component guard: the current user iff they are an admin, else null. */
export async function getAdminUser(): Promise<CurrentUser | null> {
  const user = await getCurrentUser();
  if (!user || !isAdminEmail(user.manager.email)) return null;
  return user;
}
