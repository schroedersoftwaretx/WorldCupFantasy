/**
 * Browser-backed fetch for SofaScore.
 *
 * SofaScore sits behind Cloudflare, which blocks Node's `fetch` and challenges
 * automated browsers — including a background in-page `fetch()`, because only a
 * real top-level *navigation* runs the challenge JavaScript that issues
 * cf_clearance. So this driver:
 *
 *   1. Uses your installed Chrome (channel "chrome"), not bundled Chromium,
 *      with a persistent profile so clearance survives between runs.
 *   2. Loads each API endpoint by NAVIGATING to its URL and reading the JSON
 *      the browser lands on after any challenge auto-resolves.
 *
 * SofascoreProvider accepts an injectable `fetchImpl`, so its parsing/retry
 * logic is untouched. Requests use the same-origin www.sofascore.com/api/v1
 * path so navigation stays on the cleared origin.
 *
 * Prereqs (local dev dependencies):
 *   npm i -D playwright playwright-extra puppeteer-extra-plugin-stealth
 *   npx playwright install chromium        # fallback engine
 *
 * First run: use headful and solve the Cloudflare challenge once by hand. The
 * persistent profile remembers it, so later runs can go headless:
 *   $env:SOFA_HEADFUL=1   (PowerShell)
 */
import path from "node:path";

// @ts-ignore - playwright-extra/stealth ship loose or no types; tsx ignores types at runtime.
import { chromium } from "playwright-extra";
// @ts-ignore
import StealthPlugin from "puppeteer-extra-plugin-stealth";

import { SofascoreProvider } from "../src/data/provider/sofascore.js";

chromium.use(StealthPlugin());

export interface BrowserFetcher {
  fetchImpl: typeof fetch;
  close: () => Promise<void>;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Launch persistent Chrome, clear Cloudflare once, return a fetch impl. */
export async function createBrowserFetch(): Promise<BrowserFetcher> {
  const headful = process.env["SOFA_HEADFUL"] === "1";
  const userDataDir = process.env["SOFA_PROFILE_DIR"] ?? path.resolve(".sofa-profile");

  const launchOpts = {
    headless: !headful,
    userAgent: UA,
    locale: "en-US",
    timezoneId: "America/New_York",
    viewport: { width: 1280, height: 800 },
    args: ["--disable-blink-features=AutomationControlled"],
  };

  // Prefer real Chrome (less detectable); fall back to bundled Chromium.
  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, { channel: "chrome", ...launchOpts });
  } catch {
    console.log("  (Chrome channel unavailable — falling back to bundled Chromium)");
    context = await chromium.launchPersistentContext(userDataDir, launchOpts);
  }

  const page = context.pages()[0] ?? (await context.newPage());

  // Warm up on the homepage so the challenge runs and issues cf_clearance.
  await page.goto("https://www.sofascore.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  const deadline = Date.now() + (headful ? 180_000 : 30_000);
  let nagged = false;
  while (Date.now() < deadline) {
    const cookies = await context.cookies();
    if (cookies.some((c: { name: string }) => c.name === "cf_clearance")) break;
    if (!nagged && Date.now() > deadline - (headful ? 172_000 : 22_000)) {
      console.log(
        headful
          ? "  If you see a Cloudflare challenge in the window, solve it (check the box). Waiting…"
          : "  Waiting for Cloudflare headlessly (run with $env:SOFA_HEADFUL=1 to solve by hand)…",
      );
      nagged = true;
    }
    await page.waitForTimeout(1_000);
  }
  await page.waitForTimeout(1_000);

  const fetchImpl = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const raw = typeof input === "string" ? input : (input as { url?: string }).url ?? String(input);
    const url = raw.replace("https://api.sofascore.com/api/v1", "https://www.sofascore.com/api/v1");

    // Forward the provider's headers (critically x-requested-with) into the
    // in-page fetch — this is what the real site sends. Combined with the
    // cf_clearance cookie the warm-up obtained, the WAF returns 200.
    const headers: Record<string, string> = { accept: "*/*" };
    if (init && init.headers) for (const [k, v] of Object.entries(init.headers)) headers[k] = String(v);

    const res = await page.evaluate(
      async ({ u, h }: { u: string; h: Record<string, string> }) => {
        try {
          const r = await fetch(u, { headers: h, credentials: "include" });
          return { status: r.status, ok: r.ok, body: await r.text(), retryAfter: r.headers.get("retry-after") };
        } catch (e) {
          return { status: 0, ok: false, body: String(e), retryAfter: null as string | null };
        }
      },
      { u: url, h: headers },
    );

    return {
      status: res.status,
      ok: res.ok,
      text: async () => res.body,
      json: async () => JSON.parse(res.body),
      headers: { get: (hn: string) => (hn.toLowerCase() === "retry-after" ? res.retryAfter : null) },
    };
  }) as unknown as typeof fetch;

  return { fetchImpl, close: async () => { await context.close(); } };
}

/** Build a SofaScore provider that fetches through the given browser impl. */
export function makeSofaProvider(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch): SofascoreProvider {
  const seasonId = Number(env["SOFASCORE_SEASON_ID"] ?? 58210);
  return new SofascoreProvider({
    baseUrl: env["SOFASCORE_BASE_URL"] ?? "https://www.sofascore.com/api/v1",
    uniqueTournamentId: Number(env["SOFASCORE_TOURNAMENT_ID"] ?? 16),
    seasonId,
    maxRetries: Number(env["INGEST_HTTP_MAX_RETRIES"] ?? 4),
    backoffBaseMs: Number(env["INGEST_HTTP_BACKOFF_BASE_MS"] ?? 500),
    minIntervalMs: Number(env["SOFASCORE_MIN_INTERVAL_MS"] ?? env["INGEST_HTTP_MIN_INTERVAL_MS"] ?? 1500),
    maxPages: Number(env["SOFASCORE_MAX_PAGES"] ?? 20),
    xRequestedWith: env["SOFASCORE_XRW"] ?? "690095",
    fetchImpl,
  });
}
