/**
 * The notifier the web app uses for draft emails.
 *
 * Returns a {@link ResendNotifier} when RESEND_API_KEY is configured, and
 * `undefined` otherwise. The draft service treats an absent notifier as a
 * no-op (the durable `draft_notification` rows are still written), so local
 * development and unconfigured deployments work unchanged.
 */
import { ResendNotifier } from "@/data/draft/resend-notifier";
import type { Notifier } from "@/data/draft/notifier";

/** True when email delivery is configured (RESEND_API_KEY present). */
export function emailConfigured(): boolean {
  return Boolean(process.env["RESEND_API_KEY"]);
}

/** Resolve the public base URL for building links in emails. */
function resolveBaseUrl(): string | undefined {
  const explicit = process.env["APP_BASE_URL"];
  if (explicit) return explicit;
  // Vercel exposes the deployment host (no scheme) as VERCEL_URL.
  const vercel = process.env["VERCEL_URL"];
  if (vercel) return `https://${vercel}`;
  return undefined;
}

let cached: Notifier | undefined;
let cachedKey: string | undefined;

/**
 * The shared notifier, or `undefined` when email is not configured. Memoized
 * on the API key so repeated route calls reuse one client.
 */
export function getNotifier(): Notifier | undefined {
  const apiKey = process.env["RESEND_API_KEY"];
  if (!apiKey) return undefined;
  if (cached && cachedKey === apiKey) return cached;

  const from =
    process.env["RESEND_FROM"] ?? "World Cup Fantasy <onboarding@resend.dev>";
  const baseUrl = resolveBaseUrl();
  cached = new ResendNotifier({
    apiKey,
    from,
    ...(baseUrl ? { baseUrl } : {}),
  });
  cachedKey = apiKey;
  return cached;
}
