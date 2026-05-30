/**
 * Pure mapping helpers from raw api-sports.io v3 response objects to our
 * internal provider types.
 *
 * Everything in this file is a pure function — no HTTP, no I/O. That keeps
 * the mappings cheap to unit-test against committed JSON fixtures.
 *
 * If api-sports.io changes a label or shape, update only this file and its
 * tests; the rest of the codebase depends on the `Provider*` types in
 * `./types.ts` which never see vendor field names.
 */

import type { Position, Stage } from "../db/schema.js";
import {
  ProviderMappingError,
  type ProviderFixture,
  type ProviderPlayer,
  type ProviderSquad,
  type ProviderStatLine,
} from "./types.js";

// --- Position mapping --------------------------------------------------------

/**
 * api-sports.io uses two position vocabularies depending on the endpoint:
 *   - /players/squads:   "Goalkeeper" | "Defender" | "Midfielder" | "Attacker"
 *   - /fixtures/players: "G" | "D" | "M" | "F" (in games.position)
 *
 * Both are normalised here.
 */
export function mapPosition(raw: string | null | undefined): Position {
  if (!raw) throw new ProviderMappingError(`empty position`);
  const normalised = raw.trim().toLowerCase();
  switch (normalised) {
    case "goalkeeper":
    case "g":
      return "GK";
    case "defender":
    case "d":
      return "DEF";
    case "midfielder":
    case "m":
      return "MID";
    case "attacker":
    case "forward":
    case "f":
      return "FWD";
    default:
      throw new ProviderMappingError(`unknown position label: ${JSON.stringify(raw)}`);
  }
}

// --- Stage mapping -----------------------------------------------------------

/**
 * Provider round labels → our tournament stage enum.
 *
 * The README documents the canonical mapping; small variants (extra
 * whitespace, hyphen vs en-dash, "Quarterfinals" vs "Quarter-finals") are
 * accepted defensively. Anything truly unknown throws so the ingestion
 * fails loudly rather than silently mis-staging.
 */
export function mapStage(raw: string | null | undefined): Stage {
  if (!raw) throw new ProviderMappingError(`empty round label`);
  const k = raw
    .trim()
    .toLowerCase()
    .replace(/[‐-―]/g, "-") // unicode dashes → ascii
    .replace(/\s+/g, " ");

  // Group stage matchdays. api-sports.io uses "Group Stage - 1" etc.
  if (/^group stage\s*-\s*1$/.test(k)) return "GROUP_1";
  if (/^group stage\s*-\s*2$/.test(k)) return "GROUP_2";
  if (/^group stage\s*-\s*3$/.test(k)) return "GROUP_3";

  if (k === "round of 32") return "R32";
  if (k === "round of 16") return "R16";

  if (k === "quarter-finals" || k === "quarterfinals" || k === "quarter finals") return "QF";
  if (k === "semi-finals" || k === "semifinals" || k === "semi finals") return "SF";

  if (k === "3rd place final" || k === "third place final" || k === "3rd-place final") {
    return "THIRD_PLACE";
  }

  if (k === "final") return "FINAL";

  throw new ProviderMappingError(`unknown round label: ${JSON.stringify(raw)}`);
}

// --- Fixture status mapping --------------------------------------------------

/**
 * api-sports.io short status codes. Reference:
 *   https://www.api-football.com/documentation-v3#section/Introduction/Status-of-the-fixture
 *
 * We collapse to SCHEDULED / LIVE / FINISHED. Special cases like
 * postponements remain SCHEDULED until the provider replays them with a new
 * timestamp.
 */
export function mapFixtureStatus(short: string | null | undefined): "SCHEDULED" | "LIVE" | "FINISHED" {
  if (!short) return "SCHEDULED";
  const s = short.trim().toUpperCase();
  switch (s) {
    case "TBD":
    case "NS":
    case "PST":
    case "CANC":
    case "ABD":
    case "AWD":
    case "WO":
      return "SCHEDULED";
    case "1H":
    case "2H":
    case "HT":
    case "ET":
    case "BT":
    case "P":
    case "SUSP":
    case "INT":
    case "LIVE":
      return "LIVE";
    case "FT":
    case "AET":
    case "PEN":
    case "FT_PEN":
      return "FINISHED";
    default:
      // Unknown — treat as SCHEDULED to be safe; never silently mark FINISHED.
      return "SCHEDULED";
  }
}

// --- Raw response shapes (only what we read; rest is ignored) ----------------

/** Shape of one element in /players/squads `response[*]`. */
export interface RawSquadResponse {
  team: { id: number | string; name: string };
  players: Array<{
    id: number | string;
    name: string;
    position: string;
  }>;
}

/** Shape of one element in /standings `response[0].league.standings[*][*]`. */
export interface RawStandingEntry {
  team: { id: number | string; name: string };
  /** e.g. "Group A". */
  group?: string | null;
}

/** Shape of one element in /teams `response[*]` (pre-tournament team discovery). */
export interface RawTeamEntry {
  team: { id: number | string; name: string };
}

/** Shape of one element in /fixtures `response[*]`. */
export interface RawFixtureResponse {
  fixture: {
    id: number | string;
    date: string;
    status: { long?: string; short?: string };
  };
  league: { round: string };
  teams: {
    home: { id: number | string };
    away: { id: number | string };
  };
  goals: { home: number | null; away: number | null };
  score?: {
    fulltime?: { home: number | null; away: number | null };
    extratime?: { home: number | null; away: number | null };
    penalty?: { home: number | null; away: number | null };
  };
}

/** Shape of one element in /fixtures/players `response[*]`. */
export interface RawFixturePlayersResponse {
  team: { id: number | string };
  players: Array<{
    player: { id: number | string; name: string };
    statistics: Array<{
      games?: { minutes?: number | null };
      goals?: {
        total?: number | null;
        conceded?: number | null;
        assists?: number | null;
        saves?: number | null;
      };
      cards?: { yellow?: number | null; red?: number | null };
      penalty?: {
        scored?: number | null;
        missed?: number | null;
        saved?: number | null;
      };
      // api-sports has no top-level own_goal field; we read from a side
      // channel below (some endpoints embed it under "goals" with own_goals,
      // others under a separate object). Treated defensively.
      [k: string]: unknown;
    }>;
  }>;
}

// --- Mapping functions -------------------------------------------------------

/**
 * Combine raw squads (from /players/squads) with optional standings (for
 * group labels) into our ProviderSquad list.
 *
 * `standingsByTeam` maps `sourceTeamId` → group label ("A".."L") or null.
 */
export function mapSquads(
  rawSquads: RawSquadResponse[],
  standingsByTeam: Map<string, string | null>,
): ProviderSquad[] {
  return rawSquads.map((entry) => {
    const sourceTeamId = String(entry.team.id);
    const groupLabel = standingsByTeam.get(sourceTeamId) ?? null;
    return {
      team: {
        sourceTeamId,
        name: entry.team.name,
        groupLabel,
      },
      players: entry.players.map((p) => ({
        sourcePlayerId: String(p.id),
        fullName: p.name,
        position: mapPosition(p.position),
        sourceTeamId,
      })),
    };
  });
}

/**
 * Build a teamId → group-label map from /standings response. The provider's
 * "group" field looks like "Group A"; we keep just the letter.
 */
export function indexStandings(entries: RawStandingEntry[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const e of entries) {
    const teamId = String(e.team.id);
    const m = /^group\s+([A-Z])$/i.exec((e.group ?? "").trim());
    out.set(teamId, m && m[1] ? m[1].toUpperCase() : null);
  }
  return out;
}

/** Map a list of /fixtures responses to our ProviderFixture type. */
export function mapFixtures(rawFixtures: RawFixtureResponse[]): ProviderFixture[] {
  return rawFixtures.map((entry): ProviderFixture => {
    const status = mapFixtureStatus(entry.fixture.status.short);
    const finalHome =
      entry.score?.extratime?.home ?? entry.score?.fulltime?.home ?? entry.goals.home;
    const finalAway =
      entry.score?.extratime?.away ?? entry.score?.fulltime?.away ?? entry.goals.away;
    return {
      sourceFixtureId: String(entry.fixture.id),
      stage: mapStage(entry.league.round),
      sourceHomeTeamId: String(entry.teams.home.id),
      sourceAwayTeamId: String(entry.teams.away.id),
      kickoffUtc: parseKickoff(entry.fixture.date),
      status,
      homeScore: status === "FINISHED" ? finalHome ?? null : null,
      awayScore: status === "FINISHED" ? finalAway ?? null : null,
    };
  });
}

function parseKickoff(raw: string): Date {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new ProviderMappingError(`invalid kickoff date: ${raw}`);
  }
  return d;
}

/**
 * Map per-player fixture stats. The provider response groups players under
 * their team block, which is what tells us which team a player played for —
 * required so we can record the opponent's regulation+ET goals as the
 * player's `teamConcededInRegulationAndEt`.
 *
 * @param raw          The /fixtures/players response array.
 * @param fixture      The same fixture as returned by /fixtures, so we have
 *                     the regulation+ET final score.
 * @param sourceRevision Free-form per-fixture revision tag.
 */
export function mapFixtureStats(
  raw: RawFixturePlayersResponse[],
  fixture: ProviderFixture,
  sourceRevision: string,
): ProviderStatLine[] {
  // Regulation+ET goals come from the fixture, not the per-player payload.
  const homeGoals = fixture.homeScore ?? 0;
  const awayGoals = fixture.awayScore ?? 0;

  const out: ProviderStatLine[] = [];
  for (const teamBlock of raw) {
    const teamId = String(teamBlock.team.id);
    const isHome = teamId === fixture.sourceHomeTeamId;
    const isAway = teamId === fixture.sourceAwayTeamId;
    if (!isHome && !isAway) {
      throw new ProviderMappingError(
        `fixture-stats team ${teamId} matches neither home (${fixture.sourceHomeTeamId}) nor away (${fixture.sourceAwayTeamId}) on fixture ${fixture.sourceFixtureId}`,
      );
    }
    const teamConceded = isHome ? awayGoals : homeGoals;

    for (const p of teamBlock.players) {
      const stats = p.statistics[0] ?? {};
      const games = stats.games ?? {};
      const goals = stats.goals ?? {};
      const cards = stats.cards ?? {};
      const penalty = stats.penalty ?? {};

      // api-sports does not consistently expose own goals on /fixtures/players.
      // Look in a couple of common locations defensively; default to 0.
      const ownGoalsCandidate =
        (goals as { own?: number | null }).own ??
        (stats as { own_goals?: number | null }).own_goals ??
        null;

      out.push({
        sourceFixtureId: fixture.sourceFixtureId,
        sourcePlayerId: String(p.player.id),
        minutesPlayed: nz(games.minutes),
        goals: nz(goals.total),
        assists: nz(goals.assists),
        saves: nz(goals.saves),
        yellowCards: nz(cards.yellow),
        redCards: nz(cards.red),
        penaltiesScored: nz(penalty.scored),
        penaltiesMissed: nz(penalty.missed),
        penaltiesSaved: nz(penalty.saved),
        ownGoals: nz(ownGoalsCandidate),
        teamConcededInRegulationAndEt: teamConceded,
        sourceRevision,
      });
    }
  }
  return out;
}

/** Null/undefined → 0 coercion for stat counters. */
function nz(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
