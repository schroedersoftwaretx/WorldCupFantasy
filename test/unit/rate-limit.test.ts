/**
 * Unit tests for the rate limiter (src/web/rate-limit.ts) plus a route-level
 * check that an over-limit request yields the 429 envelope with Retry-After.
 * All offline: the in-memory store is injected via setRateLimitStore.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { handle, HttpError } from "../../src/web/api.js";
import {
  clientIp,
  enforceRateLimit,
  InMemoryRateLimitStore,
  rateLimit,
  setRateLimitStore,
} from "../../src/web/rate-limit.js";
import { POST as sessionPost } from "../../app/api/auth/session/route.js";

beforeEach(() => {
  setRateLimitStore(new InMemoryRateLimitStore());
});
afterAll(() => {
  setRateLimitStore(null);
});

describe("rateLimit", () => {
  it("allows up to the limit, then throws RATE_LIMITED (429)", async () => {
    const opts = { key: "k", limit: 2, windowMs: 1000 };
    await rateLimit(opts);
    await rateLimit(opts);
    await expect(rateLimit(opts)).rejects.toBeInstanceOf(HttpError);
    await expect(rateLimit(opts)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
    });
  });

  it("attaches a positive Retry-After header via the envelope", async () => {
    const res = await handle(async () => {
      for (let i = 0; i < 3; i++) {
        await rateLimit({ key: "h", limit: 2, windowMs: 5000 });
      }
    });
    expect(res.status).toBe(429);
    const retry = res.headers.get("Retry-After");
    expect(retry).toBeTruthy();
    const secs = Number(retry);
    expect(Number.isInteger(secs)).toBe(true);
    expect(secs).toBeGreaterThan(0);
    expect(secs).toBeLessThanOrEqual(5);
    expect(await res.json()).toEqual({
      ok: false,
      error: { message: "rate limit exceeded", code: "RATE_LIMITED" },
    });
  });

  it("keeps separate keys independent", async () => {
    await rateLimit({ key: "a", limit: 1, windowMs: 1000 });
    await expect(rateLimit({ key: "a", limit: 1, windowMs: 1000 })).rejects.toThrow();
    // A different key has its own fresh window.
    await expect(rateLimit({ key: "b", limit: 1, windowMs: 1000 })).resolves.toBeUndefined();
  });

  it("resets the count after the window elapses", async () => {
    vi.useFakeTimers();
    try {
      setRateLimitStore(new InMemoryRateLimitStore());
      const opts = { key: "w", limit: 1, windowMs: 1000 };
      await rateLimit(opts);
      await expect(rateLimit(opts)).rejects.toThrow();
      vi.advanceTimersByTime(1001);
      await expect(rateLimit(opts)).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails open if the store throws", async () => {
    setRateLimitStore({
      hit: async () => {
        throw new Error("backend down");
      },
    });
    await expect(rateLimit({ key: "x", limit: 1, windowMs: 1000 })).resolves.toBeUndefined();
  });
});

describe("clientIp", () => {
  it("uses the first x-forwarded-for entry", () => {
    const r = new Request("http://t", {
      headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" },
    });
    expect(clientIp(r)).toBe("9.9.9.9");
  });
  it("falls back to x-real-ip, then 'unknown'", () => {
    expect(clientIp(new Request("http://t", { headers: { "x-real-ip": "8.8.8.8" } }))).toBe("8.8.8.8");
    expect(clientIp(new Request("http://t"))).toBe("unknown");
  });
});

describe("enforceRateLimit keying", () => {
  const reqFrom = (ip?: string): Request =>
    new Request("http://t", ip ? { headers: { "x-forwarded-for": ip } } : undefined);

  it("buckets by IP and manager id independently", async () => {
    const o = { name: "act", limit: 1, windowMs: 1000 };
    await enforceRateLimit(reqFrom("1.1.1.1"), { ...o, managerId: 1 });
    // Same IP + same manager -> blocked.
    await expect(enforceRateLimit(reqFrom("1.1.1.1"), { ...o, managerId: 1 })).rejects.toMatchObject({
      status: 429,
    });
    // Same IP, different manager -> own bucket.
    await expect(enforceRateLimit(reqFrom("1.1.1.1"), { ...o, managerId: 2 })).resolves.toBeUndefined();
    // Different IP -> own bucket.
    await expect(enforceRateLimit(reqFrom("2.2.2.2"), { ...o, managerId: 1 })).resolves.toBeUndefined();
  });
});

describe("auth/session POST rate limit (route handler)", () => {
  const loginReq = (): Request =>
    new Request("http://t/api/auth/session", {
      method: "POST",
      headers: { "x-forwarded-for": "5.5.5.5", "content-type": "application/json" },
      body: JSON.stringify({ idToken: "shaped-but-unverifiable" }),
    });

  it("returns 429 with Retry-After once the per-IP login limit is exceeded", async () => {
    setRateLimitStore(new InMemoryRateLimitStore());
    let last: Response | undefined;
    // Login limit is 10/min; the 11th from one IP must be throttled.
    for (let i = 0; i < 11; i++) last = await sessionPost(loginReq());
    expect(last?.status).toBe(429);
    expect(last?.headers.get("Retry-After")).toBeTruthy();
    expect(await last?.json()).toMatchObject({
      ok: false,
      error: { code: "RATE_LIMITED" },
    });
  });
});
