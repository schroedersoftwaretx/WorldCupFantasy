/**
 * Tournament survivorship (post-draft improvements, B1).
 *
 * Derives, from data we already ingest, whether each national team is still
 * alive in the tournament - which powers the "X / 23 players still in"
 * indicator on the standings and roster pages.
 *
 * A team is considered OUT when:
 *   - national_team.status is ELIMINATED (explicit, provider-driven), or
 *   - its last FINISHED fixture was the FINAL or the third-place playoff
 *     (the tournament is over for both sides), or
 *   - it lost a FINISHED knockout fixture on score (SF losers are kept
 *     alive: they still have the third-place playoff), or
 *   - the whole group stage is finished, at least one knockout fixture
 *     exists, and the team appears in no knockout fixture (did not advance).
 *
 * Anything undecidable from fixtures alone (e.g. a knockout match level
 * after extra time, decided on penalties, with the next round's fixture not
 * yet ingested) errs on the side of ALIVE - the next schedule ingest
 * resolves it. Before the first match finishes, everyone is alive.
 */
import type { Db } from "../data/db/client.js";
import {
  fixture,
  nationalTeam,
  player,
  rosterSlot,
  type Stage,
} from "../data/db/schema.js";
import { eq, inArray } from "drizzle-orm";

const GROUP_STAGES: readonly Stage[] = ["GROUP_1", "GROUP_2", "GROUP_3"];
const TERMINAL_STAGES: readonly Stage[] = ["THIRD_PLACE", "FINAL"];

function isGroup(stage: Stage): boolean {
  return GROUP_STAGES.includes(stage);
}
function isKnockout(stage: Stage): boolean {
  return !isGroup(stage);
}

export interface TournamentAliveState {
  /** False until at least one fixture has FINISHED. */
  started: boolean;
  /** nationalTeamId -> still alive in the tournament. */
  aliveByTeamId: Map<number, boolean>;
}

/** The slice of a fixture row the survivorship logic needs (pure/testable). */
export interface AliveFixture {
  stage: Stage;
  status: string;
  homeTeamId: number;
  awayTeamId: number;
  homeScore: number | null;
  awayScore: number | null;
  kickoffUtc: Date;
}

/** The slice of a national-team row the survivorship logic needs. */
export interface AliveTeam {
  id: number;
  status: string;
}

/**
 * Pure core of getTournamentAliveState: derive every team's alive state
 * from team statuses + fixtures alone. Exported for unit tests.
 */
export function computeAliveState(
  teams: readonly AliveTeam[],
  fixtures: readonly AliveFixture[],
): TournamentAliveState {
  const finished = fixtures.filter((f) => f.status === "FINISHED");
  const started = finished.length > 0;

  const groupFixtures = fixtures.filter((f) => isGroup(f.stage));
  const groupStageDone =
    groupFixtures.length > 0 &&
    groupFixtures.every((f) => f.status === "FINISHED");
  const knockoutTeamIds = new Set<number>();
  for (const f of fixtures) {
    if (isKnockout(f.stage)) {
      knockoutTeamIds.add(f.homeTeamId);
      knockoutTeamIds.add(f.awayTeamId);
    }
  }
  const anyKnockoutFixtures = knockoutTeamIds.size > 0;

  const aliveByTeamId = new Map<number, boolean>();
  for (const team of teams) {
    aliveByTeamId.set(team.id, isTeamAlive(team.id, team.status, {
      started,
      fixtures,
      finished,
      groupStageDone,
      anyKnockoutFixtures,
      knockoutTeamIds,
    }));
  }
  return { started, aliveByTeamId };
}

/** Compute every national team's alive/eliminated state from the DB. */
export async function getTournamentAliveState(
  db: Db,
): Promise<TournamentAliveState> {
  const teams = await db.select().from(nationalTeam);
  const fixtures = await db.select().from(fixture);
  return computeAliveState(teams, fixtures);
}

interface AliveCtx {
  started: boolean;
  fixtures: readonly AliveFixture[];
  finished: readonly AliveFixture[];
  groupStageDone: boolean;
  anyKnockoutFixtures: boolean;
  knockoutTeamIds: Set<number>;
}

function isTeamAlive(
  teamId: number,
  status: string,
  ctx: AliveCtx,
): boolean {
  if (status === "ELIMINATED") return false;
  if (!ctx.started) return true;

  // Anything still on the schedule keeps the team alive.
  const hasUpcoming = ctx.fixtures.some(
    (f) =>
      f.status !== "FINISHED" &&
      (f.homeTeamId === teamId || f.awayTeamId === teamId),
  );
  if (hasUpcoming) return true;

  const mine = ctx.finished
    .filter((f) => f.homeTeamId === teamId || f.awayTeamId === teamId)
    .sort((a, b) => a.kickoffUtc.getTime() - b.kickoffUtc.getTime());
  const last = mine[mine.length - 1];
  if (!last) return true; // tournament started, team hasn't played yet

  if (TERMINAL_STAGES.includes(last.stage)) return false;

  if (isKnockout(last.stage)) {
    const isHome = last.homeTeamId === teamId;
    const forGoals = (isHome ? last.homeScore : last.awayScore) ?? 0;
    const againstGoals = (isHome ? last.awayScore : last.homeScore) ?? 0;
    if (forGoals > againstGoals) return true; // won, next round not ingested yet
    if (forGoals < againstGoals) return last.stage === "SF"; // SF loser -> 3rd-place game
    return true; // level after ET (pens) - undecidable, err alive
  }

  // Group-stage games only: out once the group stage is fully finished,
  // knockout pairings exist, and this team is in none of them.
  if (ctx.groupStageDone && ctx.anyKnockoutFixtures) {
    return ctx.knockoutTeamIds.has(teamId);
  }
  return true;
}

export interface TeamAliveCount {
  fantasyTeamId: number;
  alive: number;
  total: number;
}

/**
 * Per fantasy team in a league: how many of its rostered players belong to
 * national teams still alive in the tournament. Returns an empty map before
 * the first match finishes (so the UI can skip the column pre-tournament).
 */
export async function getAliveCounts(
  db: Db,
  leagueId: number,
): Promise<{ started: boolean; byFantasyTeam: Map<number, TeamAliveCount> }> {
  const { started, aliveByTeamId } = await getTournamentAliveState(db);

  const slots = await db
    .select({
      fantasyTeamId: rosterSlot.fantasyTeamId,
      playerId: rosterSlot.playerId,
    })
    .from(rosterSlot)
    .where(eq(rosterSlot.leagueId, leagueId));

  const playerIds = Array.from(new Set(slots.map((s) => s.playerId)));
  const players =
    playerIds.length > 0
      ? await db
          .select({ id: player.id, nationalTeamId: player.nationalTeamId })
          .from(player)
          .where(inArray(player.id, playerIds))
      : [];
  const ntByPlayer = new Map(players.map((p) => [p.id, p.nationalTeamId]));

  const byFantasyTeam = new Map<number, TeamAliveCount>();
  for (const s of slots) {
    const entry = byFantasyTeam.get(s.fantasyTeamId) ?? {
      fantasyTeamId: s.fantasyTeamId,
      alive: 0,
      total: 0,
    };
    entry.total += 1;
    const nt = ntByPlayer.get(s.playerId);
    if (nt !== undefined && (aliveByTeamId.get(nt) ?? true)) entry.alive += 1;
    byFantasyTeam.set(s.fantasyTeamId, entry);
  }
  return { started, byFantasyTeam };
}
