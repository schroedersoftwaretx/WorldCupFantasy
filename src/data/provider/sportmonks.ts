/**
 * SportmonksProvider — concrete StatsProvider against the Sportmonks v3
 * Football API (https://api.sportmonks.com/v3/football).
 *
 * STATUS: DORMANT. Sportmonks is the only feed that supplies every per-player
 * stat the v2 ruleset rewards (crosses, accurate passes, tackles, shots on/off
 * target, saves, goals conceded) — but it has NO affordable 2026 World Cup
 * coverage (cheap/free plans are limited to a few domestic leagues). So this
 * provider is not auto-selected; it only runs when STATS_PROVIDER=sportmonks is
 * set explicitly, and is kept for the day a WC-capable plan exists. For the WC,
 * use API-Football (see src/data/provider/select.ts).
 *
 * Responsibilities (mirrors the other providers):
 *   - HTTP only; all parsing lives in ./sportmonks-mapping.ts (pure).
 *   - api_token query-param auth.
 *   - retry/backoff with jitter on 429/5xx, honouring Retry-After.
 *   - rate-limit pacing via a min interval between calls.
 *   - cursor pagination for list endpoints (fixtures).
 *
 * Endpoint choices are documented inline; verify them against your Sportmonks
 * plan + the World Cup season id before the tournament (set SPORTMONKS_SEASON_ID).
 */

import {
  mapSmFixtures,
  mapSmFixtureStats,
  mapSmSquads,
  type SmFixtureDetail,
  type SmSquadPlayer,
  type SmTeamSquad,
} from "./sportmonks-mapping.js";
import {
  ProviderMappingError,
  type ProviderFixture,
  type ProviderSquad,
  type ProviderStatLine,
  type StatsProvider,
} from "./types.js";

export interface SportmonksConfig {
  baseUrl: string;
  apiKey: string;
  seasonId: number;
  maxRetries: number;
  backoffBaseMs: number;
  minIntervalMs: number;
  /** Page size for paginated list endpoints. */
  perPage: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export function sportmonksFromEnv(env: NodeJS.ProcessEnv = process.env): SportmonksProvider {
  const apiKey = env["SPORTMONKS_KEY"] ?? env["SPORTMONKS_API_TOKEN"];
  if (!apiKey) {
    throw new Error(
      "SPORTMONKS_KEY is not set. Register at sportmonks.com and set SPORTMONKS_KEY + SPORTMONKS_SEASON_ID.",
    );
  }
  const seasonId = Number(env["SPORTMONKS_SEASON_ID"]);
  if (!Number.isInteger(seasonId) || seasonId <= 0) {
    throw new Error(
      "SPORTMONKS_SEASON_ID is not set. Set it to the 2026 World Cup season id from Sportmonks.",
    );
  }
  return new SportmonksProvider({
    baseUrl: env["SPORTMONKS_BASE_URL"] ?? "https://api.sportmonks.com/v3/football",
    apiKey,
    seasonId,
    maxRetries: Number(env["INGEST_HTTP_MAX_RETRIES"] ?? 4),
    backoffBaseMs: Number(env["INGEST_HTTP_BACKOFF_BASE_MS"] ?? 500),
    // Sportmonks limits per hour, so a tight interval is fine; still configurable.
    minIntervalMs: Number(env["SPORTMONKS_MIN_INTERVAL_MS"] ?? env["INGEST_HTTP_MIN_INTERVAL_MS"] ?? 1200),
    perPage: Number(env["SPORTMONKS_PER_PAGE"] ?? 50),
  });
}

interface SmEnvelope<T> {
  data: T;
  pagination?: { has_more?: boolean; current_page?: number; next_page?: string | null };
  message?: string;
}

export class SportmonksProvider implements StatsProvider {
  private readonly cfg: Required<Omit<SportmonksConfig, "fetchImpl" | "sleep">> & {
    fetchImpl: typeof fetch;
    sleep: (ms: number) => Promise<void>;
  };
  private lastCallAt = 0;

  constructor(cfg: SportmonksConfig) {
    this.cfg = {
      ...cfg,
      fetchImpl: cfg.fetchImpl ?? fetch,
      sleep: cfg.sleep ?? defaultSleep,
    };
  }

  // --- StatsProvider API ----------------------------------------------------

  async fetchSquads(): Promise<ProviderSquad[]> {
    // 1) Teams competing in the season.
    const teams = await this.get<Array<{ id: number; name?: string }>>(
      `/teams/seasons/${this.cfg.seasonId}`,
      {},
    );

    // 2) Per-team squad for the season (include the player so we get names/positions).
    const squads: SmTeamSquad[] = [];
    for (const t of teams.data) {
      const squad = await this.get<SmSquadPlayer[]>(
        `/squads/seasons/${this.cfg.seasonId}/teams/${t.id}`,
        { include: "player" },
      );
      squads.push({
        team_id: t.id,
        team: { id: t.id, ...(t.name !== undefined ? { name: t.name } : {}) },
        players: squad.data,
      });
    }

    // Group labels are not derived here (Sportmonks groups come from standings/
    // stages); ingestSquads accepts a null group label.
    return mapSmSquads(squads, new Map());
  }

  async fetchSchedule(): Promise<ProviderFixture[]> {
    const fixtures = await this.getList<SmFixtureDetail>("/fixtures", {
      include: "participants;state;round;stage",
      filters: `fixtureSeasons:${this.cfg.seasonId}`,
    });
    return mapSmFixtures(fixtures);
  }

  async fetchFixtureStats(sourceFixtureId: string): Promise<ProviderStatLine[]> {
    const resp = await this.get<SmFixtureDetail>(`/fixtures/${sourceFixtureId}`, {
      include: "participants;scores;state;round;stage;lineups.details.type",
    });
    const fx = resp.data;
    if (!fx || typeof fx.id !== "number") {
      throw new ProviderMappingError(`fixture ${sourceFixtureId} not found via Sportmonks`);
    }
    const revision = fx.last_processed_at ?? fx.updated_at ?? `ingest-${new Date().toISOString()}`;
    return mapSmFixtureStats(fx, revision);
  }

  // --- HTTP plumbing --------------------------------------------------------

  /** Fetch every page of a paginated list endpoint and concatenate `data`. */
  private async getList<T>(path: string, query: Record<string, string | number>): Promise<T[]> {
    const all: T[] = [];
    let page = 1;
    // Hard cap to avoid an unbounded loop if pagination metadata is missing.
    for (let guard = 0; guard < 200; guard += 1) {
      const resp = await this.get<T[]>(path, { ...query, per_page: this.cfg.perPage, page });
      if (Array.isArray(resp.data)) all.push(...resp.data);
      if (!resp.pagination?.has_more) break;
      page += 1;
    }
    return all;
  }

  private buildUrl(path: string, query: Record<string, string | number>): string {
    const u = new URL(path.replace(/^\//, ""), trailingSlash(this.cfg.baseUrl));
    u.searchParams.set("api_token", this.cfg.apiKey);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v));
    return u.toString();
  }

  private async get<T>(
    path: string,
    query: Record<string, string | number>,
  ): Promise<SmEnvelope<T>> {
    const url = this.buildUrl(path, query);
    await this.respectMinInterval();
    let attempt = 0;
    while (true) {
      try {
        const resp = await this.cfg.fetchImpl(url, { headers: { accept: "application/json" } });
        this.lastCallAt = Date.now();
        if (resp.status === 429 || resp.status >= 500) {
          if (attempt >= this.cfg.maxRetries) {
            throw new Error(`HTTP ${resp.status} from ${redact(url)} after ${attempt} retries`);
          }
          const wait = await this.retryDelay(resp, attempt);
          attempt += 1;
          await this.cfg.sleep(wait);
          continue;
        }
        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          throw new Error(`HTTP ${resp.status} from ${redact(url)}: ${body.slice(0, 200)}`);
        }
        return (await resp.json()) as SmEnvelope<T>;
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

/** Hide the api_token query param from logged URLs. */
function redact(url: string): string {
  return url.replace(/api_token=[^&]+/, "api_token=***");
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
