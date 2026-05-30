/**
 * ApiFootballProvider — concrete StatsProvider against api-sports.io v3.
 *
 * Responsibilities:
 *   - HTTP only. Mapping lives in ./api-football-mapping.ts and is pure.
 *   - Read base URL + key from constructor (or env via the factory below).
 *   - Basic retry/backoff with jitter on transient failures (network, 429,
 *     5xx). Honour the Retry-After header when present.
 *   - Rate-limit-aware pacing: sequential calls are throttled to a minimum
 *     interval (default 6.5s, ~9 req/min — under the typical 10/min free-tier
 *     cap). This keeps us under the threshold without coordinating across
 *     processes; for higher tiers raise INGEST_HTTP_MIN_INTERVAL_MS.
 *
 * No other module is allowed to import api-sports.io URLs or this provider's
 * raw response types directly.
 */

import {
  indexStandings,
  mapFixtureStats,
  mapFixtures,
  mapSquads,
  type RawFixturePlayersResponse,
  type RawFixtureResponse,
  type RawSquadResponse,
  type RawStandingEntry,
  type RawTeamEntry,
} from "./api-football-mapping.js";
import {
  ProviderMappingError,
  type ProviderFixture,
  type ProviderSquad,
  type ProviderStatLine,
  type StatsProvider,
} from "./types.js";

export interface ApiFootballConfig {
  baseUrl: string;
  apiKey: string;
  leagueId: number;
  season: number;
  maxRetries: number;
  backoffBaseMs: number;
  minIntervalMs: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Build an ApiFootballProvider from environment variables.
 *
 * Throws if `API_FOOTBALL_KEY` is missing. The CLI is allowed to call this
 * directly; tests should construct an instance manually with a fetch shim.
 */
export function apiFootballFromEnv(env: NodeJS.ProcessEnv = process.env): ApiFootballProvider {
  const apiKey = env["API_FOOTBALL_KEY"];
  if (!apiKey) {
    throw new Error(
      "API_FOOTBALL_KEY is not set. Set it in your .env or use MOCK_FIXTURES_DIR for offline use.",
    );
  }
  return new ApiFootballProvider({
    baseUrl: env["API_FOOTBALL_BASE_URL"] ?? "https://v3.football.api-sports.io",
    apiKey,
    leagueId: Number(env["WORLDCUP_LEAGUE_ID"] ?? 1),
    season: Number(env["WORLDCUP_SEASON"] ?? 2026),
    maxRetries: Number(env["INGEST_HTTP_MAX_RETRIES"] ?? 4),
    backoffBaseMs: Number(env["INGEST_HTTP_BACKOFF_BASE_MS"] ?? 500),
    minIntervalMs: Number(env["INGEST_HTTP_MIN_INTERVAL_MS"] ?? 6500),
  });
}

export class ApiFootballProvider implements StatsProvider {
  private readonly cfg: Required<Omit<ApiFootballConfig, "fetchImpl" | "sleep">> & {
    fetchImpl: typeof fetch;
    sleep: (ms: number) => Promise<void>;
  };
  private lastCallAt = 0;

  constructor(cfg: ApiFootballConfig) {
    this.cfg = {
      ...cfg,
      fetchImpl: cfg.fetchImpl ?? fetch,
      sleep: cfg.sleep ?? defaultSleep,
    };
  }

  // --- StatsProvider API ----------------------------------------------------

  async fetchSquads(): Promise<ProviderSquad[]> {
    // 1) Standings → group labels per team and the canonical list of teams.
    //    Falls back to /teams when standings are empty (pre-tournament).
    const standingsRaw = await this.get<{
      response: Array<{ league: { standings: RawStandingEntry[][] } }>;
    }>("/standings", { league: this.cfg.leagueId, season: this.cfg.season });
    const standings: RawStandingEntry[] = (standingsRaw.response[0]?.league.standings ?? []).flat();
    let teamGroups = indexStandings(standings);

    if (teamGroups.size === 0) {
      // Standings not yet published (pre-tournament). Discover teams via /teams.
      const teamsRaw = await this.get<{ response: RawTeamEntry[] }>("/teams", {
        league: this.cfg.leagueId,
        season: this.cfg.season,
      });
      for (const entry of teamsRaw.response) {
        teamGroups.set(String(entry.team.id), null);
      }
    }

    // 2) For each team, fetch its squad.
    const rawSquads: RawSquadResponse[] = [];
    for (const teamId of teamGroups.keys()) {
      const squadResp = await this.get<{ response: RawSquadResponse[] }>("/players/squads", {
        team: teamId,
      });
      if (squadResp.response[0]) rawSquads.push(squadResp.response[0]);
    }

    return mapSquads(rawSquads, teamGroups);
  }

  async fetchSchedule(): Promise<ProviderFixture[]> {
    const resp = await this.get<{ response: RawFixtureResponse[] }>("/fixtures", {
      league: this.cfg.leagueId,
      season: this.cfg.season,
    });
    return mapFixtures(resp.response);
  }

  async fetchFixtureStats(sourceFixtureId: string): Promise<ProviderStatLine[]> {
    // Need the fixture itself for regulation+ET final score.
    const fxResp = await this.get<{ response: RawFixtureResponse[] }>("/fixtures", {
      id: sourceFixtureId,
    });
    const rawFixture = fxResp.response[0];
    if (!rawFixture) {
      throw new ProviderMappingError(`fixture ${sourceFixtureId} not found via provider`);
    }
    const [fixture] = mapFixtures([rawFixture]);
    if (!fixture) throw new ProviderMappingError("mapFixtures returned empty array");

    const playersResp = await this.get<{ response: RawFixturePlayersResponse[] }>(
      "/fixtures/players",
      { fixture: sourceFixtureId },
    );

    // Use the fixture's `date` as the revision tag — api-sports.io updates the
    // `date` field's seconds when a fixture's data is rewritten, so this is
    // a reasonable monotonic proxy. Falls back to a timestamped tag.
    const revision = rawFixture.fixture.date || `ingest-${new Date().toISOString()}`;

    return mapFixtureStats(playersResp.response, fixture, revision);
  }

  // --- HTTP plumbing --------------------------------------------------------

  private buildUrl(path: string, query: Record<string, string | number>): string {
    const u = new URL(path.replace(/^\//, ""), trailingSlash(this.cfg.baseUrl));
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v));
    return u.toString();
  }

  private async get<T>(path: string, query: Record<string, string | number>): Promise<T> {
    const url = this.buildUrl(path, query);
    await this.respectMinInterval();
    let attempt = 0;
    // We retry the *whole* request on transient failures.
    while (true) {
      try {
        const resp = await this.cfg.fetchImpl(url, {
          headers: {
            "x-apisports-key": this.cfg.apiKey,
            accept: "application/json",
          },
        });
        this.lastCallAt = Date.now();
        if (resp.status === 429 || resp.status >= 500) {
          if (attempt >= this.cfg.maxRetries) {
            throw new Error(`HTTP ${resp.status} from ${url} after ${attempt} retries`);
          }
          const wait = await this.retryDelay(resp, attempt);
          attempt += 1;
          await this.cfg.sleep(wait);
          continue;
        }
        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          throw new Error(`HTTP ${resp.status} from ${url}: ${body.slice(0, 200)}`);
        }
        const data = (await resp.json()) as T & {
          errors?: Record<string, unknown> | unknown[];
          results?: number;
        };
        // api-sports.io returns HTTP 200 even for auth/quota errors.
        // Surface them explicitly rather than silently returning empty data.
        const errs = data.errors;
        if (errs) {
          const hasErrors = Array.isArray(errs)
            ? errs.length > 0
            : Object.keys(errs as Record<string, unknown>).length > 0;
          if (hasErrors) {
            throw new Error(`API error from ${path}: ${JSON.stringify(errs)}`);
          }
        }
        return data;
      } catch (err) {
        if (attempt >= this.cfg.maxRetries) throw err;
        const wait = this.cfg.backoffBaseMs * 2 ** attempt + Math.floor(Math.random() * 250);
        attempt += 1;
        await this.cfg.sleep(wait);
      }
    }
  }

  private async respectMinInterval(): Promise<void> {
    const since = Date.now() - this.lastCallAt;
    const gap = this.cfg.minIntervalMs - since;
    if (gap > 0) await this.cfg.sleep(gap);
  }

  private async retryDelay(resp: Response, attempt: number): Promise<number> {
    const retryAfter = resp.headers.get("retry-after");
    if (retryAfter) {
      const asNumber = Number(retryAfter);
      if (Number.isFinite(asNumber)) return asNumber * 1000;
      const asDate = new Date(retryAfter).getTime();
      if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
    }
    return this.cfg.backoffBaseMs * 2 ** attempt + Math.floor(Math.random() * 250);
  }
}

function trailingSlash(s: string): string {
  return s.endsWith("/") ? s : s + "/";
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
      