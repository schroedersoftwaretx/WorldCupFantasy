/**
 * Pure mapping helpers from football-data.org v4 API responses to our
 * internal provider types.
 *
 * Key differences from the API-Football provider:
 *   - Squad positions: "Goalkeeper" | "Defence" | "Midfield" | "Offence"
 *     (or specific positions like "Centre-Back" in match lineups)
 *   - Stage values: "GROUP_STAGE" + matchday for group rounds,
 *     "LAST_32" | "LAST_16" | "QUARTER_FINALS" | "SEMI_FINALS" | "THIRD_PLACE" | "FINAL"
 *   - Per-player stats are derived from match events (goals, bookings,
 *     substitutions) — saves and penaltiesSaved are not available and default to 0.
 *   - penaltiesMissed is set to 0 for PENALTY_SHOOTOUT matches to avoid
 *     conflating shootout kicks with regular-play misses.
 */

import type { Position, Stage } from "../db/schema.js";
import {
  ProviderMappingError,
  type ProviderFixture,
  type ProviderSquad,
  type ProviderStatLine,
} from "./types.js";

// ---------------------------------------------------------------------------
// Raw response shapes (only the fields we read)
// ---------------------------------------------------------------------------

export interface FdTeamEntry {
  id: number;
  name: string;
  shortName?: string;
  squad?: FdSquadMember[];
}

export interface FdSquadMember {
  id: number;
  name: string;
  position: string | null;
}

export interface FdStanding {
  stage: string;
  type: string;
  group: string | null;
  table: Array<{ team: { id: number; name: string } }>;
}

export interface FdFixture {
  id: number;
  utcDate: string;
  status: string;
  matchday: number | null;
  stage: string;
  group: string | null;
  lastUpdated?: string;
  homeTeam: { id: number; name: string };
  awayTeam: { id: number; name: string };
  score: {
    winner: string | null;
    duration: string;
    fullTime: { home: number | null; away: number | null };
    halfTime?: { home: number | null; away: number | null };
  };
}

export interface FdLineupPlayer {
  id: number;
  name: string;
  position: string | null;
  shirtNumber?: number;
}

export interface FdGoal {
  minute: number;
  injuryTime?: number | null;
  /** "REGULAR" | "PENALTY" | "OWN" */
  type: string;
  team: { id: number; name: string };
  scorer: { id: number; name: string } | null;
  assist: { id: number; name: string } | null;
}

export interface FdBooking {
  minute: number;
  team: { id: number; name: string };
  player: { id: number; name: string };
  /** "YELLOW" | "YELLOW_RED" | "RED" */
  card: string;
}

export interface FdSubstitution {
  minute: number;
  team: { id: number; name: string };
  playerOut: { id: number; name: string };
  playerIn: { id: number; name: string };
}

export interface FdPenaltyKick {
  player: { id: number; name: string };
  team: { id: number | null; name: string | null };
  scored: boolean;
  /** "MATCH" = regular-play penalty kick; "SHOOTOUT" = post-ET shootout. */
  type?: string;
}

export interface FdMatchDetail extends FdFixture {
  // lineup/bench and the event arrays are absent on football-data.org's free
  // tier, so they are optional and every reader must default them to [].
  homeTeam: FdFixture["homeTeam"] & {
    formation: string | null;
    lineup?: FdLineupPlayer[];
    bench?: FdLineupPlayer[];
    statistics?: Record<string, number | null>;
  };
  awayTeam: FdFixture["awayTeam"] & {
    formation: string | null;
    lineup?: FdLineupPlayer[];
    bench?: FdLineupPlayer[];
    statistics?: Record<string, number | null>;
  };
  goals?: FdGoal[];
  bookings?: FdBooking[];
  substitutions?: FdSubstitution[];
  penalties?: FdPenaltyKick[];
}

// ---------------------------------------------------------------------------
// Position mapping
// ---------------------------------------------------------------------------

/**
 * football-data.org uses two position vocabularies:
 *   Squad/team resource: "Goalkeeper" | "Defence" | "Midfield" | "Offence"
 *   Match lineup:        "Goalkeeper" | "Centre-Back" | "Left-Back" |
 *                        "Defensive Midfield" | "Centre-Forward" | etc.
 */
export function mapFdPosition(raw: string | null | undefined): Position {
  if (!raw) throw new ProviderMappingError(`empty position`);
  const n = raw.trim().toLowerCase();

  if (n === "goalkeeper") return "GK";

  if (
    n === "defence" ||
    n === "defender" ||
    n.includes("back") ||
    n === "sweeper" ||
    n === "libero"
  )
    return "DEF";

  if (
    n === "midfield" ||
    n === "midfielder" ||
    n.includes("midfield")
  )
    return "MID";

  if (
    n === "offence" ||
    n === "attacker" ||
    n === "forward" ||
    n.includes("forward") ||
    n.includes("winger") ||
    n === "striker"
  )
    return "FWD";

  throw new ProviderMappingError(`unknown position: ${JSON.stringify(raw)}`);
}

// ---------------------------------------------------------------------------
// Stage mapping
// ---------------------------------------------------------------------------

export function mapFdStage(stage: string, matchday: number | null): Stage {
  const s = stage.trim().toUpperCase();

  if (s === "GROUP_STAGE") {
    if (matchday === 1) return "GROUP_1";
    if (matchday === 2) return "GROUP_2";
    if (matchday === 3) return "GROUP_3";
    return "GROUP_1"; // fallback
  }
  if (s === "LAST_32") return "R32";
  if (s === "LAST_16") return "R16";
  if (s === "QUARTER_FINALS") return "QF";
  if (s === "SEMI_FINALS") return "SF";
  if (s === "THIRD_PLACE") return "THIRD_PLACE";
  if (s === "FINAL") return "FINAL";

  throw new ProviderMappingError(`unknown stage: ${JSON.stringify(stage)}`);
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

export function mapFdStatus(raw: string): "SCHEDULED" | "LIVE" | "FINISHED" {
  switch (raw.trim().toUpperCase()) {
    case "FINISHED":
      return "FINISHED";
    case "IN_PLAY":
    case "PAUSED":
    case "EXTRA_TIME":
    case "PENALTY_SHOOTOUT":
      return "LIVE";
    default:
      return "SCHEDULED";
  }
}

// ---------------------------------------------------------------------------
// Fixture mapping
// ---------------------------------------------------------------------------

export function mapFdFixtures(matches: FdFixture[]): ProviderFixture[] {
  const result: ProviderFixture[] = [];
  for (const m of matches) {
    let stage: Stage;
    try {
      stage = mapFdStage(m.stage, m.matchday);
    } catch {
      // Skip stages we don't recognise (e.g. qualifiers, playoffs).
      continue;
    }
    const status = mapFdStatus(m.status);
    const homeScore = m.score.fullTime.home;
    const awayScore = m.score.fullTime.away;
    result.push({
      sourceFixtureId: String(m.id),
      stage,
      sourceHomeTeamId: String(m.homeTeam.id),
      sourceAwayTeamId: String(m.awayTeam.id),
      kickoffUtc: new Date(m.utcDate),
      status,
      homeScore: status === "FINISHED" ? (homeScore ?? null) : null,
      awayScore: status === "FINISHED" ? (awayScore ?? null) : null,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Squad mapping
// ---------------------------------------------------------------------------

export function mapFdSquads(
  teams: FdTeamEntry[],
  groupByTeamId: Map<number, string | null>,
): ProviderSquad[] {
  return teams.map((t) => ({
    team: {
      sourceTeamId: String(t.id),
      name: t.name,
      groupLabel: groupByTeamId.get(t.id) ?? null,
    },
    players: (t.squad ?? []).map((p) => {
      let position: Position;
      try {
        position = mapFdPosition(p.position);
      } catch {
        // Unknown position — fall back to MID rather than crashing ingest.
        position = "MID";
      }
      return {
        sourcePlayerId: String(p.id),
        fullName: p.name,
        position,
        sourceTeamId: String(t.id),
      };
    }),
  }));
}

// ---------------------------------------------------------------------------
// Match stats mapping
// ---------------------------------------------------------------------------

/**
 * Derive per-player ProviderStatLine records from a finished match.
 *
 * What CAN be derived from football-data.org v4:
 *   goals, assists, yellowCards, redCards, penaltiesScored, ownGoals,
 *   minutesPlayed, teamConcededInRegulationAndEt, teamScoredInRegulationAndEt
 *
 * What CANNOT be derived (set to 0):
 *   saves, penaltiesSaved, shotsOnTarget, shotsOffTarget, tacklesSuccessful,
 *   crosses, passesCompleted
 *
 * goalsConceded is set to the team's conceded count so the keeper "goal
 * conceded" rule still works (the scorer only applies it for GKs).
 *
 * penaltiesMissed is derived from the penalties[] array for non-shootout
 * matches only. Shootout matches set it to 0 to avoid false positives from
 * shootout kicks.
 */
export function mapFdFixtureStats(
  match: FdMatchDetail,
  sourceRevision: string,
): ProviderStatLine[] {
  const duration = matchDurationMinutes(match.score.duration);
  const isShootout = match.score.duration === "PENALTY_SHOOTOUT";

  // football-data.org's free tier omits lineup/bench (and can omit the event
  // arrays) on match detail, so default everything to [] before mapping to
  // avoid crashing on `.map`/`.filter` of undefined.
  const homeLineup = match.homeTeam.lineup ?? [];
  const homeBench = match.homeTeam.bench ?? [];
  const awayLineup = match.awayTeam.lineup ?? [];
  const awayBench = match.awayTeam.bench ?? [];
  const matchGoals = match.goals ?? [];
  const matchBookings = match.bookings ?? [];

  const homeGoals = match.score.fullTime.home ?? 0;
  const awayGoals = match.score.fullTime.away ?? 0;

  // All players who appeared in lineup or bench for either team. When the
  // provider supplies no lineups (free tier), this is empty and the fixture
  // yields no automated stat lines — because scoreStatLine() zeroes any player
  // with minutesPlayed <= 0, and minutes can only be derived from the lineup.
  // Such matches must be entered by hand in /admin/stats.
  const allPlayers: Array<{ player: FdLineupPlayer; isHome: boolean }> = [
    ...homeLineup.map((p) => ({ player: p, isHome: true })),
    ...homeBench.map((p) => ({ player: p, isHome: true })),
    ...awayLineup.map((p) => ({ player: p, isHome: false })),
    ...awayBench.map((p) => ({ player: p, isHome: false })),
  ];

  const lines: ProviderStatLine[] = [];

  for (const { player, isHome } of allPlayers) {
    const pid = player.id;

    const minutesPlayed = computeMinutesPlayed(pid, match, duration);

    const goals = matchGoals.filter(
      (g) => g.scorer?.id === pid && g.type !== "OWN",
    ).length;

    const assists = matchGoals.filter((g) => g.assist?.id === pid).length;

    const ownGoals = matchGoals.filter(
      (g) => g.scorer?.id === pid && g.type === "OWN",
    ).length;

    const penaltiesScored = matchGoals.filter(
      (g) => g.scorer?.id === pid && g.type === "PENALTY",
    ).length;

    // Count regular-play missed penalties only (type="MATCH").
    // If type is absent (older data), fall back to excluding all penalties in
    // shootout games to avoid false positives.
    const penaltiesMissed = (match.penalties ?? []).filter((pk) => {
      if (pk.player.id !== pid || pk.scored) return false;
      if (pk.type) return pk.type.toUpperCase() === "MATCH";
      return !isShootout; // fallback: exclude all if shootout and type unknown
    }).length;

    const bookingsForPlayer = matchBookings.filter((b) => b.player.id === pid);
    const yellowCards = bookingsForPlayer.filter((b) => b.card === "YELLOW").length;
    // YELLOW_RED = second yellow = effective red card.
    const redCards = bookingsForPlayer.filter(
      (b) => b.card === "RED" || b.card === "YELLOW_RED",
    ).length;

    const teamConcededInRegulationAndEt = isHome ? awayGoals : homeGoals;
    const teamScoredInRegulationAndEt = isHome ? homeGoals : awayGoals;

    lines.push({
      sourceFixtureId: String(match.id),
      sourcePlayerId: String(pid),
      minutesPlayed,
      goals,
      assists,
      saves: 0,
      yellowCards,
      redCards,
      penaltiesScored,
      penaltiesMissed,
      penaltiesSaved: 0,
      ownGoals,
      teamConcededInRegulationAndEt,
      teamScoredInRegulationAndEt,
      // football-data.org free tier has no per-player on-ball stats; these
      // stay 0 and can be hand-entered in the admin editor if needed.
      shotsOnTarget: 0,
      shotsOffTarget: 0,
      tacklesSuccessful: 0,
      crosses: 0,
      passesCompleted: 0,
      // No playmaking detail on the free tier; leave 0 (hand-enter if needed).
      keyPasses: 0,
      bigChancesCreated: 0,
      // No per-player conceded; charge a keeper the team's conceded count so
      // the "goal conceded by keeper" rule still works on this provider.
      goalsConceded: teamConcededInRegulationAndEt,
      sourceRevision,
    });
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function matchDurationMinutes(duration: string): number {
  const d = duration.trim().toUpperCase();
  if (d === "EXTRA_TIME" || d === "PENALTY_SHOOTOUT") return 120;
  return 90;
}

function computeMinutesPlayed(
  playerId: number,
  match: FdMatchDetail,
  duration: number,
): number {
  const subs = match.substitutions ?? [];
  const inHomeLineup = (match.homeTeam.lineup ?? []).some((p) => p.id === playerId);
  const inAwayLineup = (match.awayTeam.lineup ?? []).some((p) => p.id === playerId);
  const inHomeBench = (match.homeTeam.bench ?? []).some((p) => p.id === playerId);
  const inAwayBench = (match.awayTeam.bench ?? []).some((p) => p.id === playerId);

  const started = inHomeLineup || inAwayLineup;
  const onBench = inHomeBench || inAwayBench;

  const subIn = subs.find((s) => s.playerIn.id === playerId);
  const subOut = subs.find((s) => s.playerOut.id === playerId);

  if (started) {
    const endMinute = subOut ? subOut.minute : duration;
    return Math.max(0, endMinute);
  }

  if (onBench) {
    if (!subIn) return 0;
    const startMinute = subIn.minute;
    // Handle double substitution (rare but possible).
    const laterSubOut = subs.find(
      (s) => s.playerOut.id === playerId && s.minute > startMinute,
    );
    const endMinute = laterSubOut ? laterSubOut.minute : duration;
    return Math.max(0, endMinute - startMinute);
  }

  return 0;
}
