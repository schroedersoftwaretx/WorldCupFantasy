/**
 * Pure mapping helpers from raw Sportmonks v3 football payloads to our
 * internal provider types. No HTTP, no I/O — cheap to unit-test against
 * committed JSON fixtures.
 *
 * Why Sportmonks: it is the only feed that supplies every stat our v2 ruleset
 * needs per player and per fixture — crosses, successful passes, tackles,
 * shots on/off target, saves, goals conceded — so a single provider can cover
 * the whole scoring model. The trade-off is the type-id system: every stat is
 * a numbered "type". We key on the human-readable `type.code` (requested via
 * the `lineups.details.type` nested include) and fall back to a type-id map,
 * so a code/id change on Sportmonks' side degrades to 0 rather than crashing.
 *
 * Stat codes/ids are from the Player Statistics Types reference:
 *   https://docs.sportmonks.com/v3/definitions/types/statistics/player-statistics
 */

import type { Position, Stage } from "../db/schema.js";
import {
  ProviderMappingError,
  type ProviderFixture,
  type ProviderPlayer,
  type ProviderSquad,
  type ProviderStatLine,
} from "./types.js";

// ---------------------------------------------------------------------------
// Stat type codes (and their numeric ids, for fallback resolution)
// ---------------------------------------------------------------------------

/** code -> type_id for the per-player stats we consume. */
export const SM_STAT_TYPE_ID: Readonly<Record<string, number>> = {
  "minutes-played": 119,
  goals: 52,
  assists: 79,
  saves: 57,
  yellowcards: 84,
  redcards: 83,
  "yellowred-cards": 85,
  "own-goals": 324,
  "goals-conceded": 88,
  "shots-on-target": 86,
  "shots-off-target": 41,
  tackles: 78,
  "total-crosses": 98,
  "accurate-passes": 116,
  penalties: 47,
};

/** Sportmonks participation type ids on a lineup row. */
const LINEUP_STARTER = 11;
const LINEUP_BENCH = 12;

// ---------------------------------------------------------------------------
// Raw payload shapes (only the fields we read)
// ---------------------------------------------------------------------------

export interface SmTypeRef {
  id: number;
  name?: string;
  code?: string;
}

/** A lineup detail (one stat for one player). `value` is usually {total}. */
export interface SmDetail {
  type_id: number;
  value: Record<string, number | null> | null;
  type?: SmTypeRef;
}

export interface SmLineupPlayer {
  player_id: number;
  team_id: number;
  /** 11 = starter, 12 = bench. */
  type_id: number;
  position_id?: number | null;
  player_name?: string;
  jersey_number?: number | null;
  details?: SmDetail[];
}

export interface SmScoreEntry {
  /** e.g. "CURRENT", "1ST_HALF", "2ND_HALF", "ET", "PENALTY_SHOOTOUT". */
  description?: string;
  score?: { participant?: string; goals?: number | null } | null;
}

export interface SmParticipant {
  id: number;
  name?: string;
  /** meta.location is "home" | "away". */
  meta?: { location?: string | null } | null;
}

export interface SmStateRef {
  id?: number;
  state?: string;
  short_name?: string;
}

export interface SmFixtureDetail {
  id: number;
  name?: string;
  starting_at?: string;
  starting_at_timestamp?: number;
  state_id?: number;
  state?: SmStateRef | null;
  participants?: SmParticipant[];
  scores?: SmScoreEntry[];
  lineups?: SmLineupPlayer[];
  round?: { id?: number; name?: string } | null;
  stage?: { id?: number; name?: string } | null;
  last_processed_at?: string;
  updated_at?: string;
}

/** A squad entry (player on a team for a season). */
export interface SmSquadPlayer {
  player_id: number;
  position_id?: number | null;
  player?: {
    id: number;
    name?: string;
    display_name?: string;
    common_name?: string;
    position_id?: number | null;
  } | null;
}

export interface SmTeamSquad {
  team_id: number;
  team?: { id: number; name?: string } | null;
  players?: SmSquadPlayer[];
}

// ---------------------------------------------------------------------------
// Position mapping
// ---------------------------------------------------------------------------

/**
 * Sportmonks position_id -> our Position. The canonical general-position ids
 * (from the position types) are 24 GK, 25 DEF, 26 MID, 27 ATT. Detailed
 * positions resolve to one of these via the API's `position` include; we map
 * the general ids here and treat anything unknown as MID (the safest default,
 * since outfield mis-classification only affects best-ball formation slotting,
 * never appearance/goal scoring).
 */
export function mapSmPosition(positionId: number | null | undefined): Position {
  switch (positionId) {
    case 24:
      return "GK";
    case 25:
      return "DEF";
    case 26:
      return "MID";
    case 27:
      return "FWD";
    default:
      return "MID";
  }
}

// ---------------------------------------------------------------------------
// Stage mapping
// ---------------------------------------------------------------------------

/**
 * Map a Sportmonks stage/round name to our tournament Stage. Knockout rounds
 * come from the stage name; group matchdays use the numeric round name
 * ("1"|"2"|"3"). Anything unrecognised throws so ingestion fails loudly
 * rather than silently mis-staging.
 */
export function mapSmStage(
  stageName: string | null | undefined,
  roundName: string | null | undefined,
): Stage {
  const s = norm(stageName);
  const r = norm(roundName);

  if (s.includes("group")) {
    if (/(^|[^0-9])1([^0-9]|$)/.test(r) || r === "1") return "GROUP_1";
    if (/(^|[^0-9])2([^0-9]|$)/.test(r) || r === "2") return "GROUP_2";
    if (/(^|[^0-9])3([^0-9]|$)/.test(r) || r === "3") return "GROUP_3";
    return "GROUP_1";
  }
  const hay = `${s} ${r}`;
  if (hay.includes("round of 32") || hay.includes("1/16")) return "R32";
  if (hay.includes("round of 16") || hay.includes("1/8")) return "R16";
  if (hay.includes("quarter")) return "QF";
  if (hay.includes("semi")) return "SF";
  if (hay.includes("3rd place") || hay.includes("third place") || hay.includes("3rd-place")) {
    return "THIRD_PLACE";
  }
  if (hay.includes("final")) return "FINAL";

  throw new ProviderMappingError(
    `unknown Sportmonks stage/round: stage=${JSON.stringify(stageName)} round=${JSON.stringify(roundName)}`,
  );
}

function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[‐-―]/g, "-").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Fixture status + score helpers
// ---------------------------------------------------------------------------

/** Sportmonks state short_name/state -> our fixture status. */
export function mapSmStatus(state: SmStateRef | null | undefined): "SCHEDULED" | "LIVE" | "FINISHED" {
  const key = (state?.short_name ?? state?.state ?? "").toUpperCase();
  switch (key) {
    case "FT":
    case "AET":
    case "FT_PEN":
    case "FINISHED":
      return "FINISHED";
    case "INPLAY_1ST_HALF":
    case "INPLAY_2ND_HALF":
    case "HT":
    case "INPLAY_ET":
    case "INPLAY_PENALTIES":
    case "BREAK":
    case "PENALTIES":
    case "EXTRA_TIME":
    case "LIVE":
      return "LIVE";
    default:
      return "SCHEDULED";
  }
}

/**
 * Regulation+ET goals per side, excluding a penalty shootout. Prefers the
 * "CURRENT" score rows (Sportmonks' running total, which after full time is
 * the reg+ET result and excludes the shootout). Returns null/null when the
 * scores are absent (e.g. an unfinished fixture).
 */
export function smRegEtScore(scores: SmScoreEntry[] | undefined): {
  home: number | null;
  away: number | null;
} {
  if (!scores || scores.length === 0) return { home: null, away: null };
  const pick = (want: string) =>
    scores.filter((e) => (e.description ?? "").toUpperCase() === want);
  let rows = pick("CURRENT");
  if (rows.length === 0) rows = pick("2ND_HALF"); // fallback if CURRENT absent
  let home: number | null = null;
  let away: number | null = null;
  for (const e of rows) {
    const loc = (e.score?.participant ?? "").toLowerCase();
    const g = typeof e.score?.goals === "number" ? e.score.goals : null;
    if (loc === "home") home = g;
    else if (loc === "away") away = g;
  }
  return { home, away };
}

// ---------------------------------------------------------------------------
// Fixture stats mapping (the centerpiece)
// ---------------------------------------------------------------------------

/** Build a code -> numeric value getter for one player's details array. */
function detailIndex(details: SmDetail[] | undefined): Map<string, Record<string, number | null>> {
  const byCode = new Map<string, Record<string, number | null>>();
  const idToCode = new Map<number, string>();
  for (const [code, id] of Object.entries(SM_STAT_TYPE_ID)) idToCode.set(id, code);
  for (const d of details ?? []) {
    const code = d.type?.code ?? idToCode.get(d.type_id);
    if (code && d.value) byCode.set(code, d.value);
  }
  return byCode;
}

function statTotal(
  byCode: Map<string, Record<string, number | null>>,
  code: string,
  key = "total",
): number {
  const v = byCode.get(code);
  const n = v?.[key];
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/**
 * Map a finished fixture's lineups to ProviderStatLine records. Both starters
 * and bench players are emitted (a bench player who never came on has 0
 * minutes and scores nothing, matching the appearance rule).
 */
export function mapSmFixtureStats(
  fx: SmFixtureDetail,
  sourceRevision: string,
): ProviderStatLine[] {
  const homeId = fx.participants?.find((p) => p.meta?.location === "home")?.id;
  const awayId = fx.participants?.find((p) => p.meta?.location === "away")?.id;
  if (homeId == null || awayId == null) {
    throw new ProviderMappingError(
      `fixture ${fx.id} is missing home/away participants (include participants)`,
    );
  }
  const { home: homeGoals, away: awayGoals } = smRegEtScore(fx.scores);
  const hg = homeGoals ?? 0;
  const ag = awayGoals ?? 0;

  const out: ProviderStatLine[] = [];
  for (const lp of fx.lineups ?? []) {
    if (lp.type_id !== LINEUP_STARTER && lp.type_id !== LINEUP_BENCH) continue;
    const isHome = lp.team_id === homeId;
    const isAway = lp.team_id === awayId;
    if (!isHome && !isAway) continue; // ignore players not on either side

    const s = detailIndex(lp.details);

    const goals = statTotal(s, "goals");
    const penaltiesScored = statTotal(s, "goals", "penalties");
    const penaltiesTaken = statTotal(s, "penalties");
    const teamConceded = isHome ? ag : hg;
    const teamScored = isHome ? hg : ag;

    out.push({
      sourceFixtureId: String(fx.id),
      sourcePlayerId: String(lp.player_id),
      minutesPlayed: statTotal(s, "minutes-played"),
      goals,
      assists: statTotal(s, "assists"),
      saves: statTotal(s, "saves"),
      yellowCards: statTotal(s, "yellowcards"),
      // straight reds + second-yellow dismissals, matching the api-football map.
      redCards: statTotal(s, "redcards") + statTotal(s, "yellowred-cards"),
      penaltiesScored,
      // No reliable per-player "penalty missed" stat; approximate as taken minus
      // converted (includes saved misses). Never negative.
      penaltiesMissed: Math.max(0, penaltiesTaken - penaltiesScored),
      penaltiesSaved: 0, // not exposed per-player by Sportmonks
      ownGoals: statTotal(s, "own-goals"),
      teamConcededInRegulationAndEt: teamConceded,
      teamScoredInRegulationAndEt: teamScored,
      shotsOnTarget: statTotal(s, "shots-on-target"),
      shotsOffTarget: statTotal(s, "shots-off-target"),
      // Sportmonks "tackles" is the per-match tackle count (Opta tackles =
      // tackles won), used as the successful-tackle figure.
      tacklesSuccessful: statTotal(s, "tackles"),
      crosses: statTotal(s, "total-crosses"),
      // "accurate-passes" = passes that found a teammate = completed passes.
      passesCompleted: statTotal(s, "accurate-passes"),
      // Playmaking. Sportmonks types: key passes and big chances created.
      keyPasses: statTotal(s, "key-passes"),
      bigChancesCreated: statTotal(s, "big-chances-created"),
      goalsConceded: statTotal(s, "goals-conceded"),
      sourceRevision,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Squads + schedule mapping
// ---------------------------------------------------------------------------

/** Map Sportmonks per-team squads to ProviderSquad. Group labels are filled
 * separately (Sportmonks groups come from standings/stages); null when absent. */
export function mapSmSquads(
  squads: SmTeamSquad[],
  groupByTeamId: Map<number, string | null>,
): ProviderSquad[] {
  return squads.map((sq) => {
    const teamId = sq.team?.id ?? sq.team_id;
    const sourceTeamId = String(teamId);
    return {
      team: {
        sourceTeamId,
        name: sq.team?.name ?? `team ${sourceTeamId}`,
        groupLabel: groupByTeamId.get(teamId) ?? null,
      },
      players: (sq.players ?? []).map((p) => {
        const pid = p.player?.id ?? p.player_id;
        const name =
          p.player?.display_name ?? p.player?.common_name ?? p.player?.name ?? `player ${pid}`;
        return {
          sourcePlayerId: String(pid),
          fullName: name,
          position: mapSmPosition(p.position_id ?? p.player?.position_id),
          sourceTeamId,
        } satisfies ProviderPlayer;
      }),
    };
  });
}

/** Map Sportmonks fixtures (with participants, state, stage, round) to ProviderFixture. */
export function mapSmFixtures(fixtures: SmFixtureDetail[]): ProviderFixture[] {
  return fixtures.map((fx): ProviderFixture => {
    const homeId = fx.participants?.find((p) => p.meta?.location === "home")?.id;
    const awayId = fx.participants?.find((p) => p.meta?.location === "away")?.id;
    if (homeId == null || awayId == null) {
      throw new ProviderMappingError(
        `fixture ${fx.id} missing home/away participants (include participants)`,
      );
    }
    const status = mapSmStatus(fx.state);
    const { home, away } = smRegEtScore(fx.scores);
    const kickoff = fx.starting_at_timestamp
      ? new Date(fx.starting_at_timestamp * 1000)
      : new Date(String(fx.starting_at).replace(" ", "T") + "Z");
    if (Number.isNaN(kickoff.getTime())) {
      throw new ProviderMappingError(`fixture ${fx.id} has an invalid kickoff: ${fx.starting_at}`);
    }
    return {
      sourceFixtureId: String(fx.id),
      stage: mapSmStage(fx.stage?.name, fx.round?.name),
      sourceHomeTeamId: String(homeId),
      sourceAwayTeamId: String(awayId),
      kickoffUtc: kickoff,
      status,
      homeScore: status === "FINISHED" ? home : null,
      awayScore: status === "FINISHED" ? away : null,
    };
  });
}
