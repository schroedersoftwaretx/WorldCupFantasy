/**
 * Central StatsProvider selection.
 *
 * One place decides which feed to use, so the CLI and the Vercel cron behave
 * identically. Selection order:
 *
 *   1. STATS_PROVIDER env, if set: "sofascore" | "mock" (explicit wins).
 *   2. MOCK_FIXTURES_DIR set        -> mock (offline/dev/tests).
 *   3. otherwise                    -> sofascore (free, no key required).
 *
 * SofaScore is the only production feed: it is the single NO-COST source that
 * covers the 2026 World Cup with the full per-player stat set the v2 ruleset
 * needs (shots, tackles, crosses, completed passes, saves) and needs no API
 * key.
 *
 * The paid feeds (API-Football, football-data.org, Sportmonks) gated the World
 * Cup behind a plan and were removed in the tech-debt cleanup; their git
 * history remains if a paid integration is ever wanted again. The shared
 * mapping layer lives on in `api-football-mapping.ts`, which the mock provider
 * reuses to exercise the same parsing code in tests.
 *
 * NOTE on feeds: stat ingestion resolves players by the
 * `player.sourcePlayerId` seeded at squad time. A single database must be
 * ingested end-to-end by ONE provider — squads, schedule, and stats from the
 * same source.
 */
import { FixtureMockProvider } from "./mock.js";
import { sofascoreFromEnv } from "./sofascore.js";
import type { StatsProvider } from "./types.js";

export type ProviderName = "sofascore" | "mock";

const VALID: ReadonlySet<string> = new Set(["sofascore", "mock"]);

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
  }
}
