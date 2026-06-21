/**
 * Pure mapping helpers from raw SofaScore (api.sofascore.com) payloads to our
 * internal provider types. No HTTP, no I/O — cheap to unit-test against
 * committed JSON fixtures.
 *
 * Why SofaScore: its undocumented-but-stable mobile JSON API is free, needs no
 * key, and is the only no-cost source that supplies EVERY per-player stat the
 * v2 ruleset rewards — minutes, goals, assists, saves, shots on/off target,
 * tackles, crosses, and completed passes — for the 2026 World Cup. The two
 * gaps versus a paid Opta feed are (a) in-play penalty MISSES/SAVES, which are
 * rare and fall back to the /admin/stats manual editor, and (b) own goals,
 * which we recover from the incidents feed.
 *
 * Data is assembled from three endpoints per fixture:
 *   - /event/{id}            -> reg+ET score, teams, status
 *   - /event/{id}/lineups    -> per-player statistics block (the bulk)
 *   - /event/{id}/incidents  -> goals, cards, own goals, in-play penalties
 *
 * Field names below were verified against live World Cup payloads (tournament
 * id 16). If SofaScore renames a key, update only this file and its tests; the
 * rest of the codebase depends on the `Provider*` types in `./types.ts`.
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
// Raw payload shapes (only the fields we read; everything else is ignored)
// ---------------------------------------------------------------------------

export interface SsTeamRef {
  id: number;
  name?: string;
  slug?: string;
}

export interface SsPlayerRef {
  id: number;
  name?: string;
  slug?: string;
  /** "G" | "D" | "M" | "F" on most endpoints. */
  position?: string | null;
}

/** One player's per-match statistics block (values are plain numbers). */
export type SsPlayerStatistics = Record<string, number | undefined>;

/** One entry under lineups.home.players[] / lineups.away.players[]. */
export interface SsLineupPlayer {
  player: SsPlayerRef;
  /** Team this player lined up for. */
  teamId?: number;
  /** "G" | "D" | "M" | "F" — the slot they filled in this match. */
  position?: string | null;
  substitute?: boolean;
  captain?: boolean;
  statistics?: SsPlayerStatistics;
}

export interface SsLineupSide {
  players?: SsLineupPlayer[];
  formation?: string;
}

export interface SsLineups {
  confirmed?: boolean;
  home?: SsLineupSide;
  away?: SsLineupSide;
}

/** Score block on an event. Knockout games add `overtime`; shootouts add `penalties`. */
export interface SsScore {
  current?: number;
  display?: number;
  period1?: number;
  period2?: number;
  normaltime?: number;
  overtime?: number;
  penalties?: number;
}

export interface SsStatus {
  code?: number;
  /** "notstarted" | "inprogress" | "finished" | "canceled" | "postponed" | ... */
  type?: string;
  description?: string;
}

export interface SsRoundInfo {
  round?: number;
  name?: string;
  /** SofaScore cup-round code: 2=final, 4=SF, 8=QF, 16=R16, 32=R32, 64=R64. */
  cupRoundType?: number;
}

export interface SsEvent {
  id: number;
  slug?: string;
  startTimestamp?: number;
  status?: SsStatus;
  homeTeam: SsTeamRef;
  awayTeam: SsTeamRef;
  homeScore?: SsScore;
  awayScore?: SsScore;
  roundInfo?: SsRoundInfo;
  tournament?: { name?: string; groupName?: string };
  changes?: { changeTimestamp?: number };
}

export interface SsIncident {
  incidentType?: string; // "goal" | "card" | "substitution" | "period" | "missedPenalty" | ...
  incidentClass?: string; // goal: "regular"|"penalty"|... ; card: "yellow"|"red"|"yellowRed"
  goalType?: string; // "regular" | "penalty" | "ownGoal"
  player?: SsPlayerRef;
  rescinded?: boolean;
  isHome?: boolean;
}

export interface SsStandingRow {
  team: SsTeamRef;
}

export interface SsStandingGroup {
  /** e.g. "Group A". */
  name?: string;
  rows?: SsStandingRow[];
}

/** A team's player pool from /team/{id}/players. */
export interface SsTeamPlayers {
  teamId: number;
  teamName?: string;
  players: Array<{ player: SsPlayerRef }>;
}

// ---------------------------------------------------------------------------
// Position mapping
// ---------------------------------------------------------------------------

/**
 * SofaScore position vocab -> our Position. Most endpoints use single letters
 * ("G"|"D"|"M"|"F"); the team-players endpoint occasionally uses full words.
 * Anything unrecognised throws so ingestion fails loudly rather than silently
 * mis-classifying a player.
 */
export function mapSsPosition(raw: string | null | undefined): Position {
  if (!raw) throw new ProviderMappingError(`empty position`);
  switch (raw.trim().toLowerCase()) {
    case "g":
    case "goalkeeper":
      return "GK";
    case "d":
    case "defender":
      return "DEF";
    case "m":
    case "midfielder":
      return "MID";
    case "f":
    case "forward":
    case "attacker":
      return "FWD";
    default:
      throw new ProviderMappingError(`unknown position label: ${JSON.stringify(raw)}`);
  }
}

// ---------------------------------------------------------------------------
// Stage mapping
// ---------------------------------------------------------------------------

/**
 * Map a SofaScore event's round context to our tournament Stage.
 *
 * Group games carry `tournament.groupName` ("Group A") and a numeric
 * `roundInfo.round` (1|2|3) = the matchday. Knockout games are recognised by
 * `roundInfo.cupRoundType` (2=final … 32=R32) with the round name as a
 * fallback. Third-place play-offs share cupRoundType space with the semis on
 * some feeds, so the name is checked for "third"/"3rd" first.
 */
export function mapSsStage(
  tournamentName: string | null | undefined,
  groupName: string | null | undefined,
  round: SsRoundInfo | null | undefined,
): Stage {
  const tName = norm(tournamentName);
  const isGroup = !!groupName || tName.includes("group");
  if (isGroup) {
    switch (round?.round) {
      case 1:
        return "GROUP_1";
      case 2:
        return "GROUP_2";
      case 3:
        return "GROUP_3";
      default:
        throw new ProviderMappingError(
          `group fixture with unmappable matchday round=${JSON.stringify(round?.round)}`,
        );
    }
  }

  // Knockout. Check name for third place first (it can otherwise look like SF).
  const hay = `${tName} ${norm(round?.name)}`;
  if (hay.includes("third") || hay.includes("3rd")) return "THIRD_PLACE";

  switch (round?.cupRoundType) {
    case 32:
      return "R32";
    case 16:
      return "R16";
    case 8:
      return "QF";
    case 4:
      return "SF";
    case 2:
      return "FINAL";
    default:
      break;
  }

  // Name fallback when cupRoundType is absent.
  if (hay.includes("round of 32") || hay.includes("1/16")) return "R32";
  if (hay.includes("round of 16") || hay.includes("1/8")) return "R16";
  if (hay.includes("quarter")) return "QF";
  if (hay.includes("semi")) return "SF";
  if (hay.includes("final")) return "FINAL";

  throw new ProviderMappingError(
    `unknown SofaScore stage: tournament=${JSON.stringify(tournamentName)} round=${JSON.stringify(round)}`,
  );
}

function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[‐-―]/g, "-").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Status + score helpers
// ---------------------------------------------------------------------------

/** SofaScore status.type -> our fixture status. */
export function mapSsStatus(status: SsStatus | null | undefined): "SCHEDULED" | "LIVE" | "FINISHED" {
  switch ((status?.type ?? "").toLowerCase()) {
    case "finished":
      return "FINISHED";
    case "inprogress":
      return "LIVE";
    default:
      // notstarted, canceled, postponed, delayed, interrupted -> SCHEDULED.
      // Never silently mark a non-finished fixture FINISHED.
      return "SCHEDULED";
  }
}

/**
 * Regulation+ET goals for one side, excluding any penalty shootout. SofaScore
 * puts the running 90'+ET total in `overtime` (when ET is played) or
 * `normaltime` otherwise; the shootout lives in the separate `penalties`
 * field, so we never pick it up. Returns null when the score is absent.
 */
export function ssRegEt(score: SsScore | null | undefined): number | null {
  if (!score) return null;
  if (typeof score.overtime === "number") return score.overtime;
  if (typeof score.normaltime === "number") return score.normaltime;
  if (typeof score.current === "number") return score.current;
  if (typeof score.display === "number") return score.display;
  return null;
}

// ---------------------------------------------------------------------------
// Squads + schedule
// ---------------------------------------------------------------------------

/** Build teamId -> group-letter ("A".."L") from /standings/total groups. */
export function indexSsStandings(groups: SsStandingGroup[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const g of groups) {
    const m = /group\s+([a-l])/i.exec(g.name ?? "");
    const label = m && m[1] ? m[1].toUpperCase() : null;
    for (const row of g.rows ?? []) {
      if (row.team?.id != null) out.set(String(row.team.id), label);
    }
  }
  return out;
}

/** Map per-team player pools to ProviderSquad. Group labels come from standings. */
export function mapSsSquads(
  teams: SsTeamPlayers[],
  groupByTeamId: Map<string, string | null>,
): ProviderSquad[] {
  return teams.map((t) => {
    const sourceTeamId = String(t.teamId);
    return {
      team: {
        sourceTeamId,
        name: t.teamName ?? `team ${sourceTeamId}`,
        groupLabel: groupByTeamId.get(sourceTeamId) ?? null,
      },
      players: t.players
        .filter((entry) => entry.player?.id != null && entry.player.position)
        .map((entry): ProviderPlayer => {
          const p = entry.player;
          return {
            sourcePlayerId: String(p.id),
            fullName: p.name ?? `player ${p.id}`,
            position: mapSsPosition(p.position),
            sourceTeamId,
          };
        }),
    };
  });
}

/** Map a list of SofaScore events to ProviderFixture. */
export function mapSsFixtures(events: SsEvent[]): ProviderFixture[] {
  return events.map((ev): ProviderFixture => {
    const status = mapSsStatus(ev.status);
    const home = ssRegEt(ev.homeScore);
    const away = ssRegEt(ev.awayScore);
    const kickoff = ev.startTimestamp != null ? new Date(ev.startTimestamp * 1000) : new Date(NaN);
    if (Number.isNaN(kickoff.getTime())) {
      throw new ProviderMappingError(`event ${ev.id} has no valid startTimestamp`);
    }
    return {
      sourceFixtureId: String(ev.id),
      stage: mapSsStage(ev.tournament?.name, ev.tournament?.groupName, ev.roundInfo),
      sourceHomeTeamId: String(ev.homeTeam.id),
      sourceAwayTeamId: String(ev.awayTeam.id),
      kickoffUtc: kickoff,
      status,
      homeScore: status === "FINISHED" ? home : null,
      awayScore: status === "FINISHED" ? away : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Fixture stats mapping (the centerpiece)
// ---------------------------------------------------------------------------

/** Read a numeric stat, coercing missing/non-finite to 0. */
function statNum(stats: SsPlayerStatistics | undefined, key: string): number {
  const v = stats?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

interface IncidentAgg {
  goals: number;
  penaltiesScored: number;
  penaltiesMissed: number;
  ownGoals: number;
  yellowCards: number;
  redCards: number;
}

/**
 * Aggregate the incidents feed per player id. Shootout kicks use a distinct
 * incidentType ("penaltyShootout"), so counting only `incidentType === "goal"`
 * naturally excludes them — satisfying the "no shootout goals" rule.
 */
export function aggregateSsIncidents(incidents: SsIncident[]): Map<string, IncidentAgg> {
  const by = new Map<string, IncidentAgg>();
  const get = (id: number): IncidentAgg => {
    const key = String(id);
    let agg = by.get(key);
    if (!agg) {
      agg = { goals: 0, penaltiesScored: 0, penaltiesMissed: 0, ownGoals: 0, yellowCards: 0, redCards: 0 };
      by.set(key, agg);
    }
    return agg;
  };

  for (const inc of incidents) {
    const type = (inc.incidentType ?? "").toLowerCase();
    const pid = inc.player?.id;

    if (type === "goal" && pid != null) {
      const goalType = (inc.goalType ?? "").toLowerCase();
      if (goalType.includes("own")) {
        get(pid).ownGoals += 1;
      } else {
        const agg = get(pid);
        agg.goals += 1;
        if (goalType === "penalty") agg.penaltiesScored += 1;
      }
    } else if (type === "missedpenalty" && pid != null) {
      get(pid).penaltiesMissed += 1;
    } else if (type === "card" && pid != null && inc.rescinded !== true) {
      const cls = (inc.incidentClass ?? "").toLowerCase();
      if (cls === "yellow") get(pid).yellowCards += 1;
      else if (cls === "red" || cls === "yellowred") get(pid).redCards += 1;
    }
  }
  return by;
}

/**
 * Map a finished fixture's lineups + incidents to ProviderStatLine records.
 *
 * @param lineups   /event/{id}/lineups payload.
 * @param incidents /event/{id}/incidents payload (`incidents` array).
 * @param fixture   The same fixture from mapSsFixtures (reg+ET score + team ids).
 * @param sourceRevision Free-form per-fixture revision tag for idempotent upserts.
 */
export function mapSsFixtureStats(
  lineups: SsLineups,
  incidents: SsIncident[],
  fixture: ProviderFixture,
  sourceRevision: string,
): ProviderStatLine[] {
  const homeGoals = fixture.homeScore ?? 0;
  const awayGoals = fixture.awayScore ?? 0;
  const inc = aggregateSsIncidents(incidents);

  const out: ProviderStatLine[] = [];
  const sides: Array<{ side: SsLineupSide | undefined; isHome: boolean }> = [
    { side: lineups.home, isHome: true },
    { side: lineups.away, isHome: false },
  ];

  for (const { side, isHome } of sides) {
    const teamConceded = isHome ? awayGoals : homeGoals;
    const teamScored = isHome ? homeGoals : awayGoals;

    for (const lp of side?.players ?? []) {
      const pid = lp.player?.id;
      if (pid == null) continue;
      const s = lp.statistics;
      const playerInc = inc.get(String(pid));

      // Position drives the GK-only goalsConceded field. Prefer the in-match
      // slot, falling back to the player's listed position.
      let isGk = false;
      try {
        isGk = mapSsPosition(lp.position ?? lp.player.position) === "GK";
      } catch {
        isGk = false;
      }

      // Goals: SofaScore writes a per-player `goals` stat when a player scores
      // (includes converted penalties); fall back to the incident count.
      const goals = statNum(s, "goals") || playerInc?.goals || 0;
      // Off-target = missed shots + blocked shots (neither is "on target").
      const shotsOffTarget = statNum(s, "shotOffTarget") + statNum(s, "blockedScoringAttempt");

      out.push({
        sourceFixtureId: fixture.sourceFixtureId,
        sourcePlayerId: String(pid),
        minutesPlayed: statNum(s, "minutesPlayed"),
        goals,
        assists: statNum(s, "goalAssist"),
        saves: statNum(s, "saves"),
        yellowCards: playerInc?.yellowCards ?? 0,
        redCards: playerInc?.redCards ?? 0,
        penaltiesScored: playerInc?.penaltiesScored ?? 0,
        // In-play penalty misses/saves are not consistently exposed by
        // SofaScore; we read what we can (incident misses, GK penaltySave stat)
        // and leave the rest to the /admin/stats manual editor.
        penaltiesMissed: playerInc?.penaltiesMissed ?? 0,
        penaltiesSaved: statNum(s, "penaltySave"),
        ownGoals: playerInc?.ownGoals ?? 0,
        teamConcededInRegulationAndEt: teamConceded,
        teamScoredInRegulationAndEt: teamScored,
        shotsOnTarget: statNum(s, "onTargetScoringAttempt"),
        shotsOffTarget,
        // SofaScore "totalTackle" is the per-match tackle count (Opta tackles =
        // tackles won), used as the successful-tackle figure.
        tacklesSuccessful: statNum(s, "totalTackle"),
        // Completed crosses; `totalCross` is the attempted count if you prefer.
        crosses: statNum(s, "accurateCross"),
        passesCompleted: statNum(s, "accuratePass"),
        // Playmaking. SofaScore exposes `keyPass` (pass leading to a shot) and
        // `bigChanceCreated` per player; both 0 when absent.
        keyPasses: statNum(s, "keyPass"),
        bigChancesCreated: statNum(s, "bigChanceCreated"),
        // SofaScore has no per-player goals-conceded stat; for the keeper it is
        // the team's reg+ET goals against. Outfield players never use this
        // field in scoring, so 0 is correct for them.
        goalsConceded: isGk ? teamConceded : 0,
        sourceRevision,
      });
    }
  }
  return out;
}
