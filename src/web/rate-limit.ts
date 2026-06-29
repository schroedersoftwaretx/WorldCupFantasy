/**
 * Rate limiting for the API layer.
 *
 * Failures flow through the same envelope as everything else: `rateLimit`
 * throws `HttpError("rate limit exceeded", "RATE_LIMITED", 429)` with a
 * `Retry-After` header, which `handle()` maps to the standard failure body.
 *
 * Storage is behind a tiny `RateLimitStore` interface. The default is an
 * in-process fixed-window counter. On serverless platforms (this app ships to
 * Vercel — see vercel.json) each instance has its OWN memory, so the in-memory
 * limiter is best-effort per-instance only; for a shared, accurate limit set
 * the Upstash Redis REST env vars (UPSTASH_REDIS_REST_URL +
 * UPSTASH_REDIS_REST_TOKEN) and the limiter automatically uses Redis instead.
 *
 * IP caveat: we trust the platform's `x-forwarded-for`. On Vercel this header
 * is set by the platform edge and is reliable. If you ever run behind a proxy
 * that does NOT strip client-supplied `x-forwarded-for`, callers could spoof
 * their IP and evade per-IP limits — terminate TLS at a trusted proxy.
 */
import { HttpError } from "./api.js";
import { logger } from "../log.js";

export interface RateLimitResult {
  /** Request count in the current window, including this hit. */
  count: number;
  /** Epoch ms when the current window resets. */
  resetAt: number;
}

export interface RateLimitStore {
  /** Record one hit for `key` and return the running count + window reset. */
  hit(key: string, windowMs: number): Promise<RateLimitResult>;
}

/**
 * In-process fixed-window store. Adequate for a single long-lived instance and
 * for tests; see the module note about serverless fan-out.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, RateLimitResult>();

  async hit(key: string, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    const existing = this.windows.get(key);
    if (!existing || now >= existing.resetAt) {
      const fresh: RateLimitResult = { count: 1, resetAt: now + windowMs };
      this.windows.set(key, fresh);
      return fresh;
    }
    existing.count += 1;
    return existing;
  }

  /** Test/maintenance helper: drop all counters. */
  reset(): void {
    this.windows.clear();
  }
}

/**
 * Upstash Redis store over the REST API (no extra dependency — uses `fetch`).
 * Fixed window via INCR + PEXPIRE(NX); PTTL gives the reset time. Errors
 * propagate to the caller, which fails open (see `rateLimit`).
 */
export class UpstashRateLimitStore implements RateLimitStore {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  async hit(key: string, windowMs: number): Promise<RateLimitResult> {
    const res = await fetch(`${this.url}/pipeline`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify([
        ["INCR", key],
        ["PEXPIRE", key, String(windowMs), "NX"],
        ["PTTL", key],
      ]),
    });
    if (!res.ok) {
      throw new Error(`upstash rate-limit store HTTP ${res.status}`);
    }
    const parsed = (await res.json()) as Array<{ result: number }>;
    const count = Number(parsed[0]?.result ?? 0);
    const pttl = Number(parsed[2]?.result ?? windowMs);
    const ttl = pttl > 0 ? pttl : windowMs;
    return { count, resetAt: Date.now() + ttl };
  }
}

let store: RateLimitStore | null = null;

/** Resolve the configured store once (Upstash if env present, else memory). */
export function getRateLimitStore(): RateLimitStore {
  if (store) return store;
  const url = process.env["UPSTASH_REDIS_REST_URL"];
  const token = process.env["UPSTASH_REDIS_REST_TOKEN"];
  store = url && token ? new UpstashRateLimitStore(url, token) : new InMemoryRateLimitStore();
  return store;
}

/** Test seam: swap the store (e.g. a fresh InMemoryRateLimitStore). */
export function setRateLimitStore(next: RateLimitStore | null): void {
  store = next;
}

export interface RateLimitOptions {
  /** Stable identity for the caller+route, e.g. "login:1.2.3.4". */
  key: string;
  /** Max requests allowed per window. */
  limit: number;
  /** Window length in ms. */
  windowMs: number;
}

/**
 * Enforce a limit for `key`. Throws HttpError 429 with `Retry-After` when the
 * window's count exceeds `limit`. Fails OPEN: if the backing store errors
 * (e.g. Redis outage) the request is allowed rather than blocked.
 */
export async function rateLimit(opts: RateLimitOptions): Promise<void> {
  let result: RateLimitResult;
  try {
    result = await getRateLimitStore().hit(opts.key, opts.windowMs);
  } catch (e) {
    logger.error("[rate-limit] store error, failing open", { err: e });
    return;
  }
  if (result.count > opts.limit) {
    const retryAfter = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
    throw new HttpError("rate limit exceeded", "RATE_LIMITED", 429, {
      "Retry-After": String(retryAfter),
    });
  }
}

/**
 * Best-effort client IP from the platform's forwarding headers. We trust
 * `x-forwarded-for` (set by Vercel's edge). Falls back to "unknown" so a
 * missing header collapses all such callers into one bucket rather than
 * throwing.
 */
export function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/**
 * Convenience wrapper used by route handlers: builds the key from the route
 * `name`, the client IP, and (where the caller is authenticated) the manager
 * id, then enforces the limit.
 */
export async function enforceRateLimit(
  request: Request,
  opts: { name: string; limit: number; windowMs: number; managerId?: number | null },
): Promise<void> {
  const ip = clientIp(request);
  const who = opts.managerId != null ? `m${opts.managerId}` : "anon";
  await rateLimit({
    key: `${opts.name}:${ip}:${who}`,
    limit: opts.limit,
    windowMs: opts.windowMs,
  });
}

/**
 * Central limit policy. Tuneable in one place. Windows are in ms.
 * Reads are left unlimited; only the auth, semi-public, and state-changing
 * endpoints below are covered.
 */
export const LIMITS = {
  // Auth: brute-force / token-stuffing guard, keyed by IP (pre-auth).
  login: { limit: 10, windowMs: 60_000 },
  // Semi-public invite surfaces.
  inviteAccept: { limit: 20, windowMs: 60_000 },
  inviteCreate: { limit: 20, windowMs: 60_000 },
  // Draft mutations (rosters are built by picks).
  draftCreate: { limit: 10, windowMs: 60_000 },
  draftStart: { limit: 10, windowMs: 60_000 },
  draftPick: { limit: 60, windowMs: 60_000 },
  draftQueue: { limit: 120, windowMs: 60_000 },
  draftForcePick: { limit: 30, windowMs: 60_000 },
  draftTick: { limit: 30, windowMs: 60_000 },
  // Heavy recompute paths.
  scoringEdit: { limit: 10, windowMs: 60_000 },
  standingsRecompute: { limit: 10, windowMs: 60_000 },
  // Light mutations.
  teamRename: { limit: 20, windowMs: 60_000 },
  flagToggle: { limit: 30, windowMs: 60_000 },
  // Admin manual stat edits.
  adminStatEdit: { limit: 30, windowMs: 60_000 },
} as const;
