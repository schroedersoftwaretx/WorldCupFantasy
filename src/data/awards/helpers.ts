/**
 * Shared internal compute helpers for the awards registry (Phase 7.1).
 *
 * Split out of registry.ts (tech-debt #3): ranking, the per-league roster
 * context, raw stat totals, and the short stage labels. Move-only; no logic
 * changed.
 */
import { eq, inArray } from "drizzle-orm";

import type { Db } from "../db/client.js";
import {
  fantasyTeam,
  manager,
  player,
  rosterSlot,
  statLine,
  type Position,
} from "../db/schema.js";
import {
  computeStandings,
  type StandingsEntry,
} from "../standings/standings.js";
import type { AwardContext, AwardEntry } from "./types.js";

// --- Small helpers -----------------------------------------------------------

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const DEFAULT_LIMIT = 10;

export type RawEntry = Omit<AwardEntry, "rank">;

/**
 * Sort raw rows by `value` (descending by default; ascending for "lower is
 * better" awards like consistency), assign 1-based ranks that are shared on an
 * equal value, and cap to `limit`. Ties beyond value are broken
 * deterministically by title then by the row's id so output is stable.
 */
export function rankEntries(
  rows: RawEntry[],
  opts: { ascending?: boolean; limit: number },
): AwardEntry[] {
  const dir = opts.ascending ? 1 : -1;
  const sorted = [...rows].sort(
    (a, b) =>
      dir * (a.value - b.value) ||
      a.title.localeCompare(b.title) ||
      idOf(a) - idOf(b),
  );
  const ranked: AwardEntry[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const row = sorted[i] as RawEntry;
    const prev = i > 0 ? (sorted[i - 1] as RawEntry) : null;
    const rank = prev !== null && prev.value === row.value ? (ranked[i - 1] as AwardEntry).rank : i + 1;
    ranked.push({ ...row, rank });
  }
  return ranked.slice(0, opts.limit);
}

function idOf(r: RawEntry): number {
  return r.fantasyTeamId ?? r.playerId ?? 0;
}

// --- League roster context (shared by the player + best-haul awards) --------

export interface LeagueRosters {
  /** Display metadata per fantasy team, keyed by team id. */
  teamMeta: Map<number, { name: string; managerId: number; managerName: string }>;
  /** Player ids rostered by each team. */
  playerIdsByTeam: Map<number, number[]>;
  /** Reverse: player id -> the (unique, per league) team that rosters them. */
  teamByPlayerId: Map<number, number>;
  /** Position of every rostered player. */
  positionByPlayerId: Map<number, Position>;
}

export async function loadLeagueRosters(
  db: Db,
  leagueId: number,
): Promise<LeagueRosters> {
  const teams = await db
    .select()
    .from(fantasyTeam)
    .where(eq(fantasyTeam.leagueId, leagueId));

  const managerIds = Array.from(new Set(teams.map((t) => t.managerId)));
  const managers =
    managerIds.length > 0
      ? await db.select().from(manager).where(inArray(manager.id, managerIds))
      : [];
  const managerName = new Map(managers.map((m) => [m.id, m.displayName]));

  const teamMeta = new Map<
    number,
    { name: string; managerId: number; managerName: string }
  >();
  for (const t of teams) {
    teamMeta.set(t.id, {
      name: t.name,
      managerId: t.managerId,
      managerName: managerName.get(t.managerId) ?? `manager #${t.managerId}`,
    });
  }

  const slots = await db
    .select()
    .from(rosterSlot)
    .where(eq(rosterSlot.leagueId, leagueId));

  const playerIdsByTeam = new Map<number, number[]>();
  const teamByPlayerId = new Map<number, number>();
  for (const s of slots) {
    const list = playerIdsByTeam.get(s.fantasyTeamId) ?? [];
    list.push(s.playerId);
    playerIdsByTeam.set(s.fantasyTeamId, list);
    teamByPlayerId.set(s.playerId, s.fantasyTeamId);
  }

  const rosteredIds = Array.from(teamByPlayerId.keys());
  const players =
    rosteredIds.length > 0
      ? await db
          .select({ id: player.id, position: player.position })
          .from(player)
          .where(inArray(player.id, rosteredIds))
      : [];
  const positionByPlayerId = new Map(players.map((p) => [p.id, p.position]));

  return { teamMeta, playerIdsByTeam, teamByPlayerId, positionByPlayerId };
}

/** Sum one raw stat_line metric per team over a league's rostered players. */
export async function teamStatTotals(
  db: Db,
  leagueId: number,
  rosters: LeagueRosters,
  metric: "goals" | "assists" | "saves",
  opts: { keepersOnly?: boolean } = {},
): Promise<Map<number, number>> {
  const totals = new Map<number, number>();
  for (const teamId of rosters.teamMeta.keys()) totals.set(teamId, 0);

  const rosteredIds = Array.from(rosters.teamByPlayerId.keys());
  if (rosteredIds.length === 0) return totals;

  const rows = await db
    .select({
      playerId: statLine.playerId,
      goals: statLine.goals,
      assists: statLine.assists,
      saves: statLine.saves,
    })
    .from(statLine)
    .where(inArray(statLine.playerId, rosteredIds));

  for (const r of rows) {
    const teamId = rosters.teamByPlayerId.get(r.playerId);
    if (teamId === undefined) continue;
    if (
      opts.keepersOnly &&
      rosters.positionByPlayerId.get(r.playerId) !== "GK"
    ) {
      continue;
    }
    const add = metric === "goals" ? r.goals : metric === "assists" ? r.assists : r.saves;
    totals.set(teamId, (totals.get(teamId) ?? 0) + add);
  }
  return totals;
}

/** Turn a per-team value map into ranked award rows (filtering zero values). */
export function teamValueEntries(
  totals: Map<number, number>,
  rosters: LeagueRosters,
  opts: { limit: number; subtitle?: (teamId: number, value: number) => string },
): AwardEntry[] {
  const rows: RawEntry[] = [];
  for (const [teamId, value] of totals) {
    if (value <= 0) continue;
    const meta = rosters.teamMeta.get(teamId);
    if (!meta) continue;
    rows.push({
      value: round2(value),
      title: meta.name,
      subtitle: opts.subtitle
        ? opts.subtitle(teamId, value)
        : `Managed by ${meta.managerName}`,
      fantasyTeamId: teamId,
      managerId: meta.managerId,
      playerId: null,
    });
  }
  return rankEntries(rows, { limit: opts.limit });
}

export async function getStandings(ctx: AwardContext): Promise<StandingsEntry[]> {
  if (ctx.standings) return [...ctx.standings];
  if (ctx.leagueId === undefined) return [];
  return computeStandings(ctx.db, ctx.leagueId);
}

export function requireLeagueId(ctx: AwardContext): number {
  if (ctx.leagueId === undefined) {
    throw new Error("league-scope award requires ctx.leagueId");
  }
  return ctx.leagueId;
}

// --- Stage labels (short) ----------------------------------------------------

export const STAGE_SHORT: Record<string, string> = {
  GROUP_1: "Group 1",
  GROUP_2: "Group 2",
  GROUP_3: "Group 3",
  R32: "Round of 32",
  R16: "Round of 16",
  QF: "Quarter-final",
  SF: "Semi-final",
  THIRD_PLACE: "Third place",
  FINAL: "Final",
};
