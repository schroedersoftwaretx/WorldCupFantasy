/**
 * FootballDataProvider — concrete StatsProvider against football-data.org v4.
 *
 * Endpoints used:
 *   GET /competitions/{code}/teams     - squad ingest (teams + players)
 *   GET /competitions/{code}/standings - group labels (graceful 404 fallback)
 *   GET /teams/{id}                    - individual squad fallback if needed
 *   GET /competitions/{code}/matches   - schedule ingest
 *   GET /matches/{id}                  - per-fixture stats ingest
 *
 * Rate limits (free tier): 10 req/min → minIntervalMs defaults to 6500 ms.
 *
 * Known limitations vs. API-Football:
 *   - saves and penaltiesSaved are always 0 (not available per-player).
 *   - penaltiesMissed is 0 for penalty-shootout matches to avoid
 *     conflating shootout kicks with regular-play misses.
 */

import {
  mapFdFixtures,
  mapFdFixtureStats,
  mapFdSquads,
  type FdFixture,
  type FdMatchDetail,
  type FdStanding,
  type FdTeamEntry,
} from "./football-data-mapping.js";
import type { ProviderFixture, ProviderSquad, ProviderStatLine, StatsProvider } from "./types.js";

export interface FootballDataConfig {
  baseUrl: string;
  apiKey: string;
  competitionCode: string;
  season: number;
  maxRetries: number;
  backoffBaseMs: number;
  minIntervalMs: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export function footballDataFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): FootballDataProvider {
  const apiKey = env["FOOTBALL_DATA_KEY"];
  if (!apiKey) {
    throw new Error(
      "FOOTBALL_DATA_KEY is not set. Register at football-data.org for a free key.",
    );
  }
  return new FootballDataProvider({
    baseUrl: env["FOOTBALL_DATA_BASE_URL"] ?? "https://api.football-data.org/v4",
    apiKey,
    competitionCode: env["FOOTBALL_DATA_COMPETITION"] ?? "WC",
    season: Number(env["FOOTBALL_DATA_SEASON"] ?? 2026),
    maxRetries: Number(env["INGEST_HTTP_MAX_RETRIES"] ?? 4),
    backoffBaseMs: Number(env["INGEST_HTTP_BACKOFF_BASE_MS"] ?? 500),
    minIntervalMs: Number(env["INGEST_HTTP_MIN_INTERVAL_MS"] ?? 6500),
  });
}

export class FootballDataProvider implements StatsProvider {
  private readonly cfg: Required<Omit<FootballDataConfig, "fetchImpl" | "sleep">> & {
    fetchImpl: typeof fetch;
    sleep: (ms: number) => Promise<void>;
  };
  private lastCallAt = 0;

  constructor(cfg: FootballDataConfig) {
    this.cfg = {
      ...cfg,
      fetchImpl: cfg.fetchImpl ?? fetch,
      sleep: cfg.sleep ?? defaultSleep,
    };
  }

  // --- StatsProvider API -------------------------------------------------------

  async fetchSquads(): Promise<ProviderSquad[]> {
    // 1) Teams list (includes squad[] for each team).
    const teamsResp = await this.get<{ teams: FdTeamEntry[] }>(
      `/competitions/${this.cfg.competitionCode}/teams`,
      { season: this.cfg.season },
    );

    // 2) Group labels from standings (gracefully skipped if unavailable).
    const groupByTeamId = new Map<number, string | null>();
    try {
      const standingsResp = await this.get<{ standings: FdStanding[] }>(
        `/competitions/${this.cfg.competitionCode}/standings`,
        { season: this.cfg.season },
      );
      for (const s of standingsResp.standings) {
        if (s.group) {
          const letter = /^GROUP_([A-L])$/i.exec(s.group)?.[1]?.toUpperCase() ?? null;
          for (const entry of s.table) {
            groupByTeamId.set(entry.team.id, letter);
          }
        }
      }
    } catch {
      // Standings not yet available — group labels will be null.
    }

    // 3) If any team is missing squad data, fetch individually.
    const missingSquad = teamsResp.teams.filter(
      (t) => !t.squad || t.squad.length === 0,
    );
    for (const t of missingSquad) {
      const teamResp = await this.get<{ squad?: FdTeamEntry["squad"] }>(
        `/teams/${t.id}`,
        {},
      );
      t.squad = teamResp.squad ?? [];
    }

    return mapFdSquads(teamsResp.teams, groupByTeamId);
  }

  async fetchSchedule(): Promise<ProviderFixture[]> {
    const resp = await this.get<{ matches: FdFixture[] }>(
      `/competitions/${this.cfg.competitionCode}/matches`,
      { season: this.cfg.season },
    );
    return mapFdFixtures(resp.matches);
  }

  async fetchFixtureStats(sourceFixtureId: string): Promise<ProviderStatLine[]> {
    const match = await this.get<FdMatchDetail>(`/matches/${sourceFixtureId}`, {});
    // Use lastUpdated as the revision tag — it advances when provider data changes.
    const revision = match.lastUpdated ?? `ingest-${new Date().toISOString()}`;
    return mapFdFixtureStats(match, revision);
  }

  // --- HTTP plumbing -----------------------------------------------------------

  private buildUrl(path: string, query: Record<string, string | number>): string {
    const u = new URL(path.replace(/^\//, ""), trailingSlash(this.cfg.baseUrl));
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v));
    return u.toString();
  }

  private async get<T>(path: string, query: Record<string, string | number>): Promise<T> {
    const url = this.buildUrl(path, query);
    await this.respectMinInterval();
    let attempt = 0;
    while (true) {
      try {
        const resp = await this.cfg.fetchImpl(url, {
          headers: {
            "X-Auth-Token": this.cfg.apiKey,
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
        return (await resp.json()) as T;
      } catch (err) {
        if (attempt >= this.cfg.maxRetries) throw err;
        const wait =
          this.cfg.backoffBaseMs * 2 ** attempt + Math.floor(Math.random() * 250);
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
