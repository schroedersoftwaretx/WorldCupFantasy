/**
 * OddsProvider — fetches WC fixture odds from The Odds API v4.
 *
 * Endpoint used:
 *   GET /v4/sports/soccer_fifa_world_cup/odds
 *   ?regions=us&markets=h2h,totals&oddsFormat=decimal
 *
 * Rate limit / caching strategy:
 *   The free tier has 500 requests/month. We cache odds in match_odds for
 *   ODDS_CACHE_HOURS (default 3h) and skip the fetch entirely when all
 *   upcoming fixtures have fresh odds. This keeps usage well under 500/month
 *   even with a 30-minute cron.
 *
 * Matching to our fixture table:
 *   The Odds API uses its own team names and IDs. We match by kickoff time
 *   (within a 2-hour window) + fuzzy team-name comparison.
 */

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, gte, inArray } from "drizzle-orm";

import * as schema from "../db/schema.js";
import { mapOddsEvents, type MatchOdds, type RawOddsEvent } from "./odds-mapping.js";

export interface OddsProviderConfig {
  apiKey: string;
  baseUrl?: string;
  sport?: string;
  /** Cache TTL in hours. Fetches are skipped when all upcoming fixtures have
   *  odds fresher than this. Default: 3. */
  cacheTtlHours?: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function oddsProviderFromEnv(env: NodeJS.ProcessEnv = process.env): OddsProvider {
  const apiKey = env["ODDS_API_KEY"];
  if (!apiKey) {
    throw new Error("ODDS_API_KEY is not set.");
  }
  return new OddsProvider({
    apiKey,
    ...(env["ODDS_API_BASE_URL"] ? { baseUrl: env["ODDS_API_BASE_URL"] } : {}),
    ...(env["ODDS_API_SPORT"] ? { sport: env["ODDS_API_SPORT"] } : {}),
    ...(env["ODDS_CACHE_HOURS"] ? { cacheTtlHours: Number(env["ODDS_CACHE_HOURS"]) } : {}),
  });
}

export class OddsProvider {
  private readonly cfg: Required<OddsProviderConfig>;

  constructor(cfg: OddsProviderConfig) {
    this.cfg = {
      baseUrl: "https://api.the-odds-api.com",
      sport: "soccer_fifa_world_cup",
      cacheTtlHours: 3,
      fetchImpl: fetch,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ...cfg,
    };
  }

  /**
   * Fetch fresh odds from the API and return as MatchOdds[].
   */
  async fetchOdds(): Promise<MatchOdds[]> {
    const url = new URL(
      `/v4/sports/${this.cfg.sport}/odds`,
      this.cfg.baseUrl,
    );
    url.searchParams.set("apiKey", this.cfg.apiKey);
    url.searchParams.set("regions", "us,uk,eu");
    url.searchParams.set("markets", "h2h,totals");
    url.searchParams.set("oddsFormat", "decimal");

    const resp = await this.cfg.fetchImpl(url.toString());
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Odds API HTTP ${resp.status}: ${body.slice(0, 300)}`);
    }
    const data = (await resp.json()) as RawOddsEvent[];
    return mapOddsEvents(data);
  }

  /**
   * Fetch odds and upsert them into the match_odds table, matching to our
   * fixture rows by kickoff time + team name.
   *
   * Returns a summary of how many fixtures were matched and updated.
   */
  async ingestOdds(
    db: NodePgDatabase<typeof schema>,
  ): Promise<{ fetched: number; matched: number; skipped: number }> {
    const cacheTtlMs = this.cfg.cacheTtlHours * 60 * 60 * 1000;
    const now = new Date();
    const staleThreshold = new Date(now.getTime() - cacheTtlMs);

    // Find upcoming (SCHEDULED) fixtures that need fresh odds.
    const upcomingFixtures = await db
      .select({
        id: schema.fixture.id,
        kickoffUtc: schema.fixture.kickoffUtc,
        homeTeamId: schema.fixture.homeTeamId,
        awayTeamId: schema.fixture.awayTeamId,
        homeTeamName: schema.nationalTeam.name,
      })
      .from(schema.fixture)
      .innerJoin(schema.nationalTeam, eq(schema.fixture.homeTeamId, schema.nationalTeam.id))
      .where(
        and(
          eq(schema.fixture.status, "SCHEDULED"),
          gte(schema.fixture.kickoffUtc, now),
        ),
      );

    if (upcomingFixtures.length === 0) {
      return { fetched: 0, matched: 0, skipped: 0 };
    }

    // Check which fixtures already have fresh odds (skip the API call if all do).
    const fixtureIds = upcomingFixtures.map((f) => f.id);
    const existingOdds = await db
      .select({ fixtureId: schema.matchOdds.fixtureId, fetchedAt: schema.matchOdds.fetchedAt })
      .from(schema.matchOdds)
      .where(inArray(schema.matchOdds.fixtureId, fixtureIds));

    const freshFixtureIds = new Set(
      existingOdds
        .filter((o) => o.fetchedAt >= staleThreshold)
        .map((o) => o.fixtureId),
    );

    const staleFixtures = upcomingFixtures.filter((f) => !freshFixtureIds.has(f.id));
    if (staleFixtures.length === 0) {
      return { fetched: 0, matched: 0, skipped: upcomingFixtures.length };
    }

    // Fetch fresh odds from the API.
    const oddsEvents = await this.fetchOdds();

    // We also need away team names for matching.
    const awayTeamIds = [...new Set(staleFixtures.map((f) => f.awayTeamId))];
    const awayTeams = await db
      .select({ id: schema.nationalTeam.id, name: schema.nationalTeam.name })
      .from(schema.nationalTeam)
      .where(inArray(schema.nationalTeam.id, awayTeamIds));
    const awayTeamMap = new Map(awayTeams.map((t) => [t.id, t.name]));

    let matched = 0;
    const skipped = upcomingFixtures.length - staleFixtures.length;

    for (const fixture of staleFixtures) {
      const awayTeamName = awayTeamMap.get(fixture.awayTeamId) ?? "";
      const odds = findMatchingOdds(oddsEvents, fixture.kickoffUtc, fixture.homeTeamName, awayTeamName);
      if (!odds) continue;

      await db
        .insert(schema.matchOdds)
        .values({
          fixtureId: fixture.id,
          homeWinP: odds.homeWinP,
          drawP: odds.drawP,
          awayWinP: odds.awayWinP,
          expectedTotalGoals: odds.expectedTotalGoals,
          homeCleanSheetP: odds.homeCleanSheetP,
          awayCleanSheetP: odds.awayCleanSheetP,
          fetchedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.matchOdds.fixtureId,
          set: {
            homeWinP: odds.homeWinP,
            drawP: odds.drawP,
            awayWinP: odds.awayWinP,
            expectedTotalGoals: odds.expectedTotalGoals,
            homeCleanSheetP: odds.homeCleanSheetP,
            awayCleanSheetP: odds.awayCleanSheetP,
            fetchedAt: now,
          },
        });
      matched++;
    }

    return { fetched: oddsEvents.length, matched, skipped };
  }
}

// ---------------------------------------------------------------------------
// Fixture matching helpers
// ---------------------------------------------------------------------------

/**
 * Find the Odds API event that best matches a given fixture by kickoff time
 * (within 2 hours) and team names (fuzzy).
 */
function findMatchingOdds(
  events: MatchOdds[],
  kickoffUtc: Date,
  homeTeamName: string,
  awayTeamName: string,
): MatchOdds | null {
  const kickoffMs = kickoffUtc.getTime();
  const twoHours = 2 * 60 * 60 * 1000;

  const candidates = events.filter((e) => {
    const eventMs = new Date(e.commenceTime).getTime();
    return Math.abs(eventMs - kickoffMs) <= twoHours;
  });

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;

  // Multiple same-time events (shouldn't happen in WC but be safe): pick best name match.
  return candidates.reduce((best, e) => {
    const score =
      nameScore(e.homeTeamName, homeTeamName) +
      nameScore(e.awayTeamName, awayTeamName);
    const bestScore =
      nameScore(best.homeTeamName, homeTeamName) +
      nameScore(best.awayTeamName, awayTeamName);
    return score > bestScore ? e : best;
  });
}

/**
 * Simple fuzzy name score: 1.0 for exact match (case-insensitive),
 * 0.5 if one name contains the other, 0 otherwise.
 */
function nameScore(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1.0;
  if (na.includes(nb) || nb.includes(na)) return 0.5;
  // Check significant word overlap
  const wordsA = new Set(na.split(/\s+/).filter((w) => w.length > 2));
  const wordsB = nb.split(/\s+/).filter((w) => w.length > 2);
  const overlap = wordsB.filter((w) => wordsA.has(w)).length;
  return overlap > 0 ? 0.3 * overlap : 0;
}

function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
