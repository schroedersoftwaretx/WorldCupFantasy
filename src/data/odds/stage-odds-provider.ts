/**
 * StageOddsProvider — fetches per-team "reach stage" probabilities from The
 * Odds API tournament futures markets and upserts them into `stage_odds`.
 *
 * Each tracked stage maps to a dedicated Odds API sport key plus the number of
 * SLOTS at that stage (used to de-vig the field — see stage-odds-mapping.ts):
 *
 *   CHAMPION  soccer_fifa_world_cup_winner                       slots 1
 *   FINAL     soccer_fifa_world_cup_to_reach_final               slots 2
 *   SF        soccer_fifa_world_cup_to_reach_the_semi_final      slots 4
 *   QF        soccer_fifa_world_cup_to_reach_the_quarter_final   slots 8
 *   R16       soccer_fifa_world_cup_to_reach_the_round_of_16      slots 16
 *
 * IMPORTANT: which futures markets The Odds API actually carries varies by
 * tournament and over time (the winner market is the most reliable; the
 * "to reach" markets are offered by some books). Get the current list from
 * `GET /v4/sports`. Any market that 404s or returns no bookmaker is skipped
 * gracefully, so unavailable stages simply have no data (the board hides them).
 * The full map can be overridden with the STAGE_ODDS_MARKETS env var (JSON
 * array of { stage, sportKey, slots }).
 *
 * Rate limits: futures move slowly, so we cache per-stage for
 * STAGE_ODDS_CACHE_HOURS (default 12h) and skip the fetch when fresh.
 */

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";

import * as schema from "../db/schema.js";
import {
  mapStageOutrights,
  matchTeamName,
  type RawOutrightEvent,
} from "./stage-odds-mapping.js";

export interface StageMarket {
  stage: string; // "CHAMPION" | "FINAL" | "SF" | "QF" | "R16"
  sportKey: string;
  slots: number;
}

export const DEFAULT_STAGE_MARKETS: StageMarket[] = [
  { stage: "CHAMPION", sportKey: "soccer_fifa_world_cup_winner", slots: 1 },
  { stage: "FINAL", sportKey: "soccer_fifa_world_cup_to_reach_final", slots: 2 },
  { stage: "SF", sportKey: "soccer_fifa_world_cup_to_reach_the_semi_final", slots: 4 },
  { stage: "QF", sportKey: "soccer_fifa_world_cup_to_reach_the_quarter_final", slots: 8 },
  { stage: "R16", sportKey: "soccer_fifa_world_cup_to_reach_the_round_of_16", slots: 16 },
];

export interface StageOddsProviderConfig {
  apiKey: string;
  baseUrl?: string;
  markets?: StageMarket[];
  /** Cache TTL in hours. Per-stage fetches are skipped when fresher. Default 12. */
  cacheTtlHours?: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

function parseMarketsEnv(raw: string | undefined): StageMarket[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as StageMarket[];
    if (Array.isArray(parsed) && parsed.every((m) => m.stage && m.sportKey && m.slots)) {
      return parsed;
    }
  } catch {
    // fall through to default
  }
  return undefined;
}

export function stageOddsProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): StageOddsProvider {
  const apiKey = env["ODDS_API_KEY"];
  if (!apiKey) {
    throw new Error("ODDS_API_KEY is not set.");
  }
  const markets = parseMarketsEnv(env["STAGE_ODDS_MARKETS"]);
  return new StageOddsProvider({
    apiKey,
    ...(env["ODDS_API_BASE_URL"] ? { baseUrl: env["ODDS_API_BASE_URL"] } : {}),
    ...(markets ? { markets } : {}),
    ...(env["STAGE_ODDS_CACHE_HOURS"]
      ? { cacheTtlHours: Number(env["STAGE_ODDS_CACHE_HOURS"]) }
      : {}),
  });
}

export interface StageOddsIngestSummary {
  stagesFetched: number;
  stagesSkipped: number;
  stagesUnavailable: number;
  rowsUpserted: number;
  unmatched: string[];
}

export class StageOddsProvider {
  private readonly cfg: Required<StageOddsProviderConfig>;

  constructor(cfg: StageOddsProviderConfig) {
    this.cfg = {
      baseUrl: "https://api.the-odds-api.com",
      markets: DEFAULT_STAGE_MARKETS,
      cacheTtlHours: 12,
      fetchImpl: fetch,
      ...cfg,
    };
  }

  /**
   * Fetch the outrights market for a single sport key. Returns [] when the
   * market is not available (404) so one missing stage never aborts the rest.
   */
  async fetchStageMarket(sportKey: string): Promise<RawOutrightEvent[]> {
    const url = new URL(`/v4/sports/${sportKey}/odds`, this.cfg.baseUrl);
    url.searchParams.set("apiKey", this.cfg.apiKey);
    url.searchParams.set("regions", "us,uk,eu");
    url.searchParams.set("markets", "outrights");
    url.searchParams.set("oddsFormat", "decimal");

    const resp = await this.cfg.fetchImpl(url.toString());
    if (resp.status === 404 || resp.status === 422) {
      // Unknown/unavailable market for this tournament — treat as "no data".
      return [];
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Odds API HTTP ${resp.status} for ${sportKey}: ${body.slice(0, 200)}`);
    }
    return (await resp.json()) as RawOutrightEvent[];
  }

  /**
   * Fetch every configured stage market and upsert per-team reach
   * probabilities into stage_odds, matching team names to our national_team
   * rows. Stale-per-stage caching keeps API usage low.
   */
  async ingestStageOdds(
    db: NodePgDatabase<typeof schema>,
  ): Promise<StageOddsIngestSummary> {
    const now = new Date();
    const staleThreshold = new Date(now.getTime() - this.cfg.cacheTtlHours * 3600_000);

    const teams = await db
      .select({ id: schema.nationalTeam.id, name: schema.nationalTeam.name })
      .from(schema.nationalTeam);

    // Most-recent fetch per stage, to honour the cache TTL.
    const freshRows = await db
      .select({ stage: schema.stageOdds.stage, fetchedAt: schema.stageOdds.fetchedAt })
      .from(schema.stageOdds);
    const latestByStage = new Map<string, Date>();
    for (const r of freshRows) {
      const prev = latestByStage.get(r.stage);
      if (!prev || r.fetchedAt > prev) latestByStage.set(r.stage, r.fetchedAt);
    }

    const summary: StageOddsIngestSummary = {
      stagesFetched: 0,
      stagesSkipped: 0,
      stagesUnavailable: 0,
      rowsUpserted: 0,
      unmatched: [],
    };

    for (const market of this.cfg.markets) {
      const latest = latestByStage.get(market.stage);
      if (latest && latest >= staleThreshold) {
        summary.stagesSkipped++;
        continue;
      }

      const events = await this.fetchStageMarket(market.sportKey);
      const probs = mapStageOutrights(events, market.slots);
      if (probs.size === 0) {
        summary.stagesUnavailable++;
        continue;
      }
      summary.stagesFetched++;

      for (const [apiName, reachP] of probs) {
        const teamId = matchTeamName(apiName, teams);
        if (teamId === null) {
          summary.unmatched.push(`${market.stage}:${apiName}`);
          continue;
        }
        await db
          .insert(schema.stageOdds)
          .values({ nationalTeamId: teamId, stage: market.stage, reachP, fetchedAt: now })
          .onConflictDoUpdate({
            target: [schema.stageOdds.nationalTeamId, schema.stageOdds.stage],
            set: { reachP, fetchedAt: now },
          });
        summary.rowsUpserted++;
      }
    }

    return summary;
  }

  /** Delete stage_odds rows for teams already eliminated (reach prob is 0). */
  async zeroOutEliminated(db: NodePgDatabase<typeof schema>): Promise<void> {
    await db
      .update(schema.stageOdds)
      .set({ reachP: 0 })
      .where(
        sql`${schema.stageOdds.nationalTeamId} IN (
          SELECT ${schema.nationalTeam.id} FROM ${schema.nationalTeam}
          WHERE ${schema.nationalTeam.status} = 'ELIMINATED'
        )`,
      );
  }
}
