/**
 * Central StatsProvider selection.
 *
 * One place decides which feed to use, so the CLI and the Vercel cron behave
 * identically. Selection order:
 *
 *   1. STATS_PROVIDER env, if set: "sportmonks" | "api-football" |
 *      "football-data" | "mock" (explicit wins).
 *   2. MOCK_FIXTURES_DIR set        -> mock (offline/dev).
 *   3. API_FOOTBALL_KEY set         -> api-football (recommended for the WC).
 *   4. FOOTBALL_DATA_KEY set        -> football-data.
 *   5. otherwise                    -> api-football.
 *
 * API-Football is the working source for the 2026 World Cup: it covers the WC
 * (free tier, rate-limited) and supplies shots, tackles, passes, saves, and
 * goals conceded per player. Its one gap is crosses, which are entered by hand
 * via the admin stat editor.
 *
 * Sportmonks is NOT in the auto-detect chain — it has no affordable World Cup
 * coverage (free plans are limited to a few domestic leagues), so it is only
 * reachable by setting STATS_PROVIDER=sportmonks explicitly. The provider is
 * kept for the day a WC-capable Sportmonks plan is available.
 *
 * NOTE on mixing feeds: stat ingestion resolves players by the
 * `player.sourcePlayerId` seeded at squad time, and each provider uses its own
 * ids. So a single database must be ingested end-to-end by ONE provider —
 * squads, schedule, and stats from the same source.
 */
import { apiFootballFromEnv } from "./api-football.js";
import { footballDataFromEnv } from "./football-data.js";
import { FixtureMockProvider } from "./mock.js";
import { sportmonksFromEnv } from "./sportmonks.js";
import type { StatsProvider } from "./types.js";

export type ProviderName = "sportmonks" | "api-football" | "football-data" | "mock";

const VALID: ReadonlySet<string> = new Set([
  "sportmonks",
  "api-football",
  "football-data",
  "mock",
]);

/** Resolve the provider name without constructing it. */
export function resolveProviderName(env: NodeJS.ProcessEnv = process.env): ProviderName {
  const explicit = (env["STATS_PROVIDER"] ?? "").toLowerCase().trim();
  if (explicit) {
    if (!VALID.has(explicit)) {
      throw new Error(
        `STATS_PROVIDER="${explicit}" is invalid. Use one of: ${[...VALID].join(", ")}.`,
      );
    }
    return explicit as ProviderName;
  }
  if (env["MOCK_FIXTURES_DIR"]) return "mock";
  // Sportmonks is intentionally excluded from auto-detect (no free WC data);
  // it is only used when STATS_PROVIDER=sportmonks is set explicitly above.
  if (env["API_FOOTBALL_KEY"]) return "api-football";
  if (env["FOOTBALL_DATA_KEY"]) return "football-data";
  return "api-football";
}

/** Construct the selected StatsProvider from the environment. */
export function statsProviderFromEnv(env: NodeJS.ProcessEnv = process.env): StatsProvider {
  switch (resolveProviderName(env)) {
    case "mock":
      return new FixtureMockProvider({ root: env["MOCK_FIXTURES_DIR"] as string });
    case "sportmonks":
      return sportmonksFromEnv(env);
    case "football-data":
      return footballDataFromEnv(env);
    case "api-football":
      return apiFootballFromEnv(env);
  }
}
