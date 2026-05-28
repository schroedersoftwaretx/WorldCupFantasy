/**
 * Validate a post-login redirect target ("?next=...").
 *
 * Only a site-relative path is allowed. An absolute URL (`https://evil`) or
 * a protocol-relative path (`//evil`) would be an open-redirect, so anything
 * that does not start with a single "/" falls back to the dashboard.
 *
 * Zero imports - safe to use from client components.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw) return "/";
  if (!raw.startsWith("/")) return "/";
  // Reject protocol-relative ("//host") and backslash tricks ("/\\host").
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}
