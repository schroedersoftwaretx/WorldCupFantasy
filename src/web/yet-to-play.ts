/**
 * "Yet to play" — read-layer survivorship companion to alive.ts.
 *
 * Tells each fantasy team how many of its rostered players can still add to
 * that team's CURRENT-STAGE points: i.e. players whose national team has a
 * fixture in the active stage that has NOT finished yet (SCHEDULED or LIVE).
 *
 * Mirrors alive.ts deliberately: a PURE core over a fixtures slice
 * (`computeYetToPlayState`) that is unit-testable, plus a thin db-first
 * wrapper (`getYetToPlayCounts`) that joins rosters and returns per-team
 * counts. Read-only over existing tables; no scoring logic is touched.
 */
import type { Db } from "../data/db/client.js";
import { fixture, player, rosterSlot, type Stage } from "../data/db/schema.js";
import { STAGE_ORDER } from "../data/stats/aggregate.js";
import { eq, inArray } from "drizzle-orm";

/** The slice of a fixture row the yet-to-play logic needs (pure/testable). */
export interface YetToPlayFixture {
  stage: Stage;
  status: string;
  homeTeamId: number;
  awayTeamId: number;
}

export interface YetToPlayState {
  /** The active matchday/round (see computeCurrentStage). */
  currentStage: Stage;
  /** True when the current stage still has an unfinished fixture. */
  active: boolean;
  /** National-team ids with a non-FINISHED fixture in the current stage. */
  pendingTeamIds: Set<number>;
}

/**
 * The active stage: the earliest stage (in tournament order) with at least one
 * non-FINISHED fixture. If every fixture is FINISHED, the latest stage that has
 * any fixture. Before any fixtures exist, GROUP_1. Pure; exported for tests.
 */
export function computeCurrentStage(
  fixtures: readonly YetToPlayFixture[],
): Stage {
  if (fixtures.length === 0) return "GROUP_1";
  for (const stage of STAGE_ORDER) {
    if (fixtures.some((f) => f.stage === stage && f.status !== "FINISHED")) {
      return stage;
    }
  }
  // Every fixture is FINISHED: fall back to the latest stage with any fixture.
  for (let i = STAGE_ORDER.length - 1; i >= 0; i -= 1) {
    const stage = STAGE_ORDER[i] as Stage;
    if (fixtures.some((f) => f.stage === stage)) return stage;
  }
  return "GROUP_1";
}

/**
 * Pure core: derive the current stage and the set of national teams that still
 * have an unfinished fixture in it. Exported for unit tests.
 */
export function computeYetToPlayState(
  fixtures: readonly YetToPlayFixture[],
): YetToPlayState {
  const currentStage = computeCurrentStage(fixtures);
  const pendingTeamIds = new Set<number>();
  for (const f of fixtures) {
    if (f.stage === currentStage && f.status !== "FINISHED") {
      pendingTeamIds.add(f.homeTeamId);
      pendingTeamIds.add(f.awayTeamId);
    }
  }
  return { currentStage, active: pendingTeamIds.size > 0, pendingTeamIds };
}

export interface TeamYetToPlayCount {
  fantasyTeamId: number;
  /** Rostered players whose nation has an unfinished current-stage fixture. */
  yetToPlay: number;
  /** Roster size (mirrors the Alive bar's `total`). */
  total: number;
}

/**
 * Per fantasy team in a league: how many rostered players can still score in
 * the current stage (their nation has a SCHEDULED/LIVE fixture in it), over the
 * roster total. `active` is false (UI hides the bar) once the current stage has
 * no unfinished fixtures.
 */
export async function getYetToPlayCounts(
  db: Db,
  leagueId: number,
): Promise<{
  active: boolean;
  currentStage: Stage;
  byFantasyTeam: Map<number, TeamYetToPlayCount>;
}> {
  const fixtures = await db
    .select({
      stage: fixture.stage,
      status: fixture.status,
      homeTeamId: fixture.homeTeamId,
      awayTeamId: fixture.awayTeamId,
    })
    .from(fixture);
  const { currentStage, active, pendingTeamIds } =
    computeYetToPlayState(fixtures);

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

  const byFantasyTeam = new Map<number, TeamYetToPlayCount>();
  for (const s of slots) {
    const entry = byFantasyTeam.get(s.fantasyTeamId) ?? {
      fantasyTeamId: s.fantasyTeamId,
      yetToPlay: 0,
      total: 0,
    };
    entry.total += 1;
    const nt = ntByPlayer.get(s.playerId);
    if (nt !== undefined && pendingTeamIds.has(nt)) entry.yetToPlay += 1;
    byFantasyTeam.set(s.fantasyTeamId, entry);
  }
  return { active, currentStage, byFantasyTeam };
}
