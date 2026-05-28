/**
 * Auth constants with zero imports.
 *
 * Kept dependency-free on purpose: Edge middleware imports `SESSION_COOKIE`,
 * and middleware must not pull in `firebase-admin` (it is not Edge-safe).
 */

/** Name of the httpOnly session cookie. */
export const SESSION_COOKIE = "wc_session";

/**
 * Session lifetime. Firebase session cookies permit 5 minutes .. 14 days;
 * five days is a comfortable middle ground for a private league.
 */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 5;
