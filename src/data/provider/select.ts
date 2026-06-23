/**
 * Central StatsProvider selection.
 *
 * One place decides which feed to use, so the CLI and the Vercel cron behave
 * identically. Selection order:
 *
 *   1. STATS_PROVIDER env, if set: "sofascore" | "sportmonks" | "api-football"
 *      | "football-data" | "mock" (explicit wins).
 *   2. MOCK_FIXTURES_DIR set        -> mock (offline/dev).
 *   3. API_FOOTBALL_KEY set         -> api-football.
 *   4. FOOTBALL_DATA_KEY set        -> football-data.
 *   5. otherwise                    -> sofascore (free, no key required).
 *
 * SofaScore is the default because it is the only NO-COST source that covers
 * the 2026 World Cup with the full per-player stat set the v2 ruleset needs
 * (shots, tackles, crosses, completed passes, saves) and needs no API key. The
 * paid feeds gate the WC behind a plan; API-Football's free tier historically
 * excluded current seasons, so a free key cannot read WC 2026 data.
 *
 * API-Football / football-data.org remain available when their keys are set
 * (or via explicit STATS_PROVIDER) for anyone on a paid plan who prefers them.
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
import { sofascoreFromEnv } from "./sofascore.js";
import { sportmonksFromEnv } from "./sportmonks.js";
import type { StatsProvider } from "./types.js";

export type ProviderName = "sofascore" | "sportmonks" | "api-football" | "football-data" | "mock";

const VALID: ReadonlySet<string> = new Set([
  "sofascore",
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
  // Default: SofaScore needs no key and is the only free WC-complete feed.
  return "sofascore";
}

/** Construct the selected StatsProvider from the environment. */
export function statsProviderFromEnv(env: NodeJS.ProcessEnv = process.env): StatsProvider {
  switch (resolveProviderName(env)) {
    case "mock":
      return new FixtureMockProvider({ root: env["MOCK_FIXTURES_DIR"] as string });
    case "sofascore":
      return sofascoreFromEnv(env);
    case "sportmonks":
      return sportmonksFromEnv(env);
    case "football-data":
      return footballDataFromEnv(env);
    case "api-football":
      return apiFootballFromEnv(env);
  }
}
