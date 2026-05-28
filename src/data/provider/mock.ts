/**
 * FixtureMockProvider — StatsProvider backed by local JSON files.
 *
 * Used by tests and for offline development. The JSON files are shaped
 * exactly like real api-sports.io v3 responses (one JSON per endpoint),
 * and are run through the same mapping functions ApiFootballProvider uses
 * — so the mock simultaneously exercises the mapping layer.
 *
 * Expected directory layout:
 *
 *   <root>/
 *     standings.json              (api-sports.io /standings response)
 *     squads.json                 (array of /players/squads `response[0]` objects)
 *     schedule.json               (api-sports.io /fixtures response)
 *     fixture-stats/<id>.json     (api-sports.io /fixtures/players response)
 *
 * The provider only depends on the filesystem; nothing else.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  indexStandings,
  mapFixtureStats,
  mapFixtures,
  mapSquads,
  type RawFixturePlayersResponse,
  type RawFixtureResponse,
  type RawSquadResponse,
  type RawStandingEntry,
} from "./api-football-mapping.js";
import {
  ProviderMappingError,
  type ProviderFixture,
  type ProviderSquad,
  type ProviderStatLine,
  type StatsProvider,
} from "./types.js";

export interface FixtureMockProviderOptions {
  /** Root directory containing the JSON files. */
  root: string;
}

export class FixtureMockProvider implements StatsProvider {
  constructor(private readonly opts: FixtureMockProviderOptions) {}

  async fetchSquads(): Promise<ProviderSquad[]> {
    const standings = await this.loadStandings();
    const squads = await readJson<{ response: RawSquadResponse[] } | RawSquadResponse[]>(
      join(this.opts.root, "squads.json"),
    );
    const raw: RawSquadResponse[] = Array.isArray(squads) ? squads : squads.response;
    return mapSquads(raw, indexStandings(standings));
  }

  async fetchSchedule(): Promise<ProviderFixture[]> {
    const resp = await readJson<{ response: RawFixtureResponse[] } | RawFixtureResponse[]>(
      join(this.opts.root, "schedule.json"),
    );
    const raw: RawFixtureResponse[] = Array.isArray(resp) ? resp : resp.response;
    return mapFixtures(raw);
  }

  async fetchFixtureStats(sourceFixtureId: string): Promise<ProviderStatLine[]> {
    // Need the fixture for regulation+ET final score.
    const schedule = await this.fetchSchedule();
    const fixture = schedule.find((f) => f.sourceFixtureId === sourceFixtureId);
    if (!fixture) {
      throw new ProviderMappingError(
        `mock provider: fixture ${sourceFixtureId} not found in schedule.json`,
      );
    }

    const playersPath = join(this.opts.root, "fixture-stats", `${sourceFixtureId}.json`);
    const resp = await readJson<
      { response: RawFixturePlayersResponse[] } | RawFixturePlayersResponse[]
    >(playersPath);
    const raw: RawFixturePlayersResponse[] = Array.isArray(resp) ? resp : resp.response;

    // Embed the file's mtime / a stable revision tag.
    const revision = await fileRevision(playersPath);
    return mapFixtureStats(raw, fixture, revision);
  }

  private async loadStandings(): Promise<RawStandingEntry[]> {
    const standingsPath = join(this.opts.root, "standings.json");
    const resp = await readJson<{
      response: Array<{ league: { standings: RawStandingEntry[][] } }>;
    }>(standingsPath);
    const standings = resp.response[0]?.league.standings;
    if (!standings) return [];
    return standings.flat();
  }
}

async function readJson<T>(path: string): Promise<T> {
  try {
    const buf = await readFile(path, "utf8");
    return JSON.parse(buf) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProviderMappingError(`mock fixture file not found: ${path}`);
    }
    throw err;
  }
}

/**
 * Use the file's mtime in ISO form as a stable per-fixture revision tag.
 * This way re-saving the JSON in development changes the revision, and
 * the ingest path correctly treats it as an update.
 */
async function fileRevision(path: string): Promise<string> {
  try {
    const s = await stat(path);
    return `mock-${s.mtime.toISOString()}`;
  } catch {
    return `mock-${path}`;
  }
}
