/**
 * SofascoreProvider — concrete StatsProvider against SofaScore's free,
 * undocumented mobile JSON API (https://api.sofascore.com/api/v1).
 *
 * Why this exists: it is the only NO-COST source that covers the 2026 World
 * Cup with the full per-player stat set our v2 ruleset needs (shots, tackles,
 * crosses, completed passes, saves) — the paid APIs gate the WC behind a plan
 * and the free ones (football-data.org) only give basic stats. There is no API
 * key; access is unauthenticated.
 *
 * Responsibilities (mirrors the other providers):
 *   - HTTP only; all parsing lives in ./sofascore-mapping.ts (pure).
 *   - retry/backoff with jitter on 429/5xx, honouring Retry-After.
 *   - rate-limit pacing via a min interval between calls (be a polite scraper).
 *   - browser-like headers so the CDN doesn't reject the request.
 *
 * Caveats: this is an unofficial endpoint. It can change without notice and is
 * against SofaScore's ToS for commercial use — fine for a private league, and
 * the mapping module is isolated so a schema change is a one-file fix.
 */

import {
  indexSsStandings,
  mapSsFixtures,
  mapSsFixtureStats,
  mapSsSquads,
  type SsEvent,
  type SsIncident,
  type SsLineups,
  type SsPlayerRef,
  type SsStandingGroup,
  type SsTeamPlayers,
} from "./sofascore-mapping.js";
import {
  ProviderMappingError,
  type ProviderFixture,
  type ProviderSquad,
  type ProviderStatLine,
  type StatsProvider,
} from "./types.js";

export interface SofascoreConfig {
  baseUrl: string;
  /** SofaScore unique-tournament id for the FIFA World Cup (16). */
  uniqueTournamentId: number;
  /** SofaScore season id for the 2026 World Cup (58210). */
  seasonId: number;
  maxRetries: number;
  backoffBaseMs: number;
  minIntervalMs: number;
  /** Hard cap on schedule pagination pages per direction. */
  maxPages: number;
  /**
   * Value for the `x-requested-with` header. SofaScore's Cloudflare WAF gates
   * the data endpoints (event/team/unique-tournament) behind this header — the
   * web app sends a constant build token and requests without it get a 403
   * "challenge". The value changes only when SofaScore redeploys their web
   * build; override via SOFASCORE_XRW if it ever rotates.
   */
  xRequestedWith: string;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export function sofascoreFromEnv(env: NodeJS.ProcessEnv = process.env): SofascoreProvider {
  const seasonId = Number(env["SOFASCORE_SEASON_ID"] ?? 58210);
  if (!Number.isInteger(seasonId) || seasonId <= 0) {
    throw new Error(
      "SOFASCORE_SEASON_ID is invalid. Set it to the 2026 World Cup season id (default 58210).",
    );
  }
  return new SofascoreProvider({
    baseUrl: env["SOFASCORE_BASE_URL"] ?? "https://www.sofascore.com/api/v1",
    uniqueTournamentId: Number(env["SOFASCORE_TOURNAMENT_ID"] ?? 16),
    seasonId,
    maxRetries: Number(env["INGEST_HTTP_MAX_RETRIES"] ?? 4),
    backoffBaseMs: Number(env["INGEST_HTTP_BACKOFF_BASE_MS"] ?? 500),
    // No published rate limit; ~1.5s between calls keeps us courteous.
    minIntervalMs: Number(env["SOFASCORE_MIN_INTERVAL_MS"] ?? env["INGEST_HTTP_MIN_INTERVAL_MS"] ?? 1500),
    maxPages: Number(env["SOFASCORE_MAX_PAGES"] ?? 20),
    xRequestedWith: env["SOFASCORE_XRW"] ?? "690095",
  });
}

export class SofascoreProvider implements StatsProvider {
  private readonly cfg: Required<Omit<SofascoreConfig, "fetchImpl" | "sleep">> & {
    fetchImpl: typeof fetch;
    sleep: (ms: number) => Promise<void>;
  };
  private lastCallAt = 0;

  constructor(cfg: SofascoreConfig) {
    this.cfg = {
      ...cfg,
      fetchImpl: cfg.fetchImpl ?? fetch,
      sleep: cfg.sleep ?? defaultSleep,
    };
  }

  // --- StatsProvider API ----------------------------------------------------

  async fetchSquads(): Promise<ProviderSquad[]> {
    const ut = this.cfg.uniqueTournamentId;
    const season = this.cfg.seasonId;

    // 1) Standings -> group labels + the canonical list of teams.
    const standings = await this.get<{ standings?: SsStandingGroup[] }>(
      `/unique-tournament/${ut}/season/${season}/standings/total`,
    );
    const groups = standings.standings ?? [];
    const groupByTeamId = indexSsStandings(groups);

    const teamRefs = new Map<string, string>(); // id -> name
    for (const g of groups) {
      for (const row of g.rows ?? []) {
        if (row.team?.id != null) teamRefs.set(String(row.team.id), row.team.name ?? "");
      }
    }
    if (teamRefs.size === 0) {
      throw new ProviderMappingError(
        `no teams found in standings for tournament ${ut} season ${season} (groups not seeded yet?)`,
      );
    }

    // 2) Each team's player pool.
    const teams: SsTeamPlayers[] = [];
    for (const [teamId, teamName] of teamRefs) {
      const resp = await this.get<{ players?: Array<{ player: SsPlayerRef }> }>(
        `/team/${teamId}/players`,
      );
      teams.push({
        teamId: Number(teamId),
        teamName,
        players: resp.players ?? [],
      });
    }

    return mapSsSquads(teams, groupByTeamId);
  }

  async fetchSchedule(): Promise<ProviderFixture[]> {
    const ut = this.cfg.uniqueTournamentId;
    const season = this.cfg.seasonId;
    const events: SsEvent[] = [];
    const seen = new Set<number>();

    // Past ("last") and upcoming ("next") events are paginated separately.
    for (const direction of ["last", "next"] as const) {
      for (let page = 0; page < this.cfg.maxPages; page += 1) {
        let resp: { events?: SsEvent[]; hasNextPage?: boolean };
        try {
          resp = await this.get<{ events?: SsEvent[]; hasNextPage?: boolean }>(
            `/unique-tournament/${ut}/season/${season}/events/${direction}/${page}`,
          );
        } catch (err) {
          // SofaScore returns 404 (not an empty 200) once you page past the
          // last page of events. Treat it as "no more pages" for this
          // direction rather than a fatal error.
          if (err instanceof Error && err.message.includes("HTTP 404")) break;
          throw err;
        }
        const batch = resp.events ?? [];
        for (const ev of batch) {
          if (!seen.has(ev.id)) {
            seen.add(ev.id);
            events.push(ev);
          }
        }
        if (batch.length === 0 || resp.hasNextPage === false) break;
      }
    }

    return mapSsFixtures(events);
  }

  async fetchFixtureStats(sourceFixtureId: string): Promise<ProviderStatLine[]> {
    // 1) Event itself: reg+ET score, team ids, status.
    const eventResp = await this.get<{ event?: SsEvent }>(`/event/${sourceFixtureId}`);
    const ev = eventResp.event;
    if (!ev || typeof ev.id !== "number") {
      throw new ProviderMappingError(`event ${sourceFixtureId} not found via SofaScore`);
    }
    const [fixture] = mapSsFixtures([ev]);
    if (!fixture) throw new ProviderMappingError("mapSsFixtures returned empty array");

    // 2) Lineups (per-player statistics) and 3) incidents (goals/cards/etc.).
    const lineups = await this.get<SsLineups>(`/event/${sourceFixtureId}/lineups`);
    const incidentsResp = await this.get<{ incidents?: SsIncident[] }>(
      `/event/${sourceFixtureId}/incidents`,
    );

    const revision =
      ev.changes?.changeTimestamp != null
        ? String(ev.changes.changeTimestamp)
        : ev.startTimestamp != null
          ? String(ev.startTimestamp)
          : `ingest-${new Date().toISOString()}`;

    return mapSsFixtureStats(lineups, incidentsResp.incidents ?? [], fixture, revision);
  }

  // --- HTTP plumbing --------------------------------------------------------

  private buildUrl(path: string): string {
    return new URL(path.replace(/^\//, ""), trailingSlash(this.cfg.baseUrl)).toString();
  }

  private async get<T>(path: string): Promise<T> {
    const url = this.buildUrl(path);
    await this.respectMinInterval();
    let attempt = 0;
    while (true) {
      try {
        const resp = await this.cfg.fetchImpl(url, {
          headers: {
            accept: "*/*",
            "accept-language": "en-US,en;q=0.9",
            // The decisive header: SofaScore's WAF gates the data endpoints
            // behind `x-requested-with` set to their web build token. Without
            // it every event/team/tournament call returns 403 "challenge".
            "x-requested-with": this.cfg.xRequestedWith,
            "user-agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            referer: "https://www.sofascore.com/",
            origin: "https://www.sofascore.com",
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
