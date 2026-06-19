/**
 * Tournament awards registry (Phase 7.1 - DERIVED awards only).
 *
 * A registry of awards computed purely from already-stored data (score_entry,
 * stat_line, roster_slot, fantasy_team, standings) - it never writes and adds
 * no migration. Every award is recomputable on demand and spec-verified
 * against hand-computed expectations.
 *
 * Two scopes:
 *   - "league"  awards rank the fantasy teams WITHIN one league (the Trophy
 *               Room). Player awards (Golden Boot etc.) are attributed to the
 *               manager who rosters the scoring players.
 *   - "global"  awards are tournament-wide and player-attributed (the Stats
 *               Hub awards section), scored against HUB_RULESET_VERSION.
 *
 * Ruleset version is ALWAYS supplied by the caller (never hard-coded here):
 *   - the per-league Trophy Room passes the league's OWN
 *     `league.scoringRuleset.version` so award points match what that league
 *     sees on its standings/roster surfaces;
 *   - the global Stats Hub passes HUB_RULESET_VERSION.
 *
 * Style mirrors the stats aggregate / standings services: a few bulk queries
 * load everything, then all ranking is in-memory and pure.
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
  bestSingleMatchHauls,
  loadRefs,
  statLeaders,
} from "../stats/aggregate.js";
import { teamInsights } from "../stats/differentials.js";
import {
  computeStandings,
  type StandingsEntry,
  type XiSlot,
} from "../standings/standings.js";
import { scoredStages } from "../standings/snapshot.js";

// --- Public types ------------------------------------------------------------

export type AwardScope = "league" | "global";

/** One ranked row of an award's leaderboard. Flat + JSON-serializable. */
export interface AwardEntry {
  /** 1-based; rows with an equal headline value share a rank. */
  rank: number;
  /** The headline number this award ranks by (rounded to 2dp). */
  value: number;
  /** Primary label: a fantasy team name (league scope) or player name (global). */
  title: string;
  /** Secondary line: manager, nation, opponent/stage, or "" when not applicable. */
  subtitle: string;
  /** The fantasy team this row is attributed to, or null (global player awards). */
  fantasyTeamId: number | null;
  /** The manager this row is attributed to, or null. */
  managerId: number | null;
  /** The underlying player, when the row is about a single player, else null. */
  playerId: number | null;
  /** Best-ball XI for the "best single XI" award; omitted otherwise. */
  lineup?: XiSlot[];
}

/** Context handed to every award's `compute`. */
export interface AwardContext {
  db: Db;
  /** Ruleset version to score against (caller-derived; never hard-coded). */
  rulesetVersion: string;
  /** Required for league-scope awards; ignored by global ones. */
  leagueId?: number;
  /** Cap each leaderboard. Defaults to 10. */
  limit?: number;
  /**
   * Optional pre-computed standings (a perf hint shared by the manager awards
   * so the Trophy Room computes the ladder once). Awards fall back to
   * `computeStandings` when absent, so each stays independently runnable.
   */
  standings?: readonly StandingsEntry[];
}

/** A registry award: an id, a label, and a pure ranked-list `compute`. */
export interface AwardDefinition {
  id: string;
  label: string;
  scope: AwardScope;
  /** One-line human description of what the award measures. */
  description: string;
  /** Unit/explanation for `value`, e.g. "goals", "pts", "saves", "variance". */
  unit: string;
  compute(ctx: AwardContext): Promise<AwardEntry[]>;
}

/** An award plus its computed leaderboard. */
export interface AwardResult {
  id: string;
  label: string;
  scope: AwardScope;
  description: string;
  unit: string;
  entries: AwardEntry[];
}

// --- Small helpers -----------------------------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const DEFAULT_LIMIT = 10;

type RawEntry = Omit<AwardEntry, "rank">;

/**
 * Sort raw rows by `value` (descending by default; ascending for "lower is
 * better" awards like consistency), assign 1-based ranks that are shared on an
 * equal value, and cap to `limit`. Ties beyond value are broken
 * deterministically by title then by the row's id so output is stable.
 */
function rankEntries(
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

interface LeagueRosters {
  /** Display metadata per fantasy team, keyed by team id. */
  teamMeta: Map<number, { name: string; managerId: number; managerName: string }>;
  /** Player ids rostered by each team. */
  playerIdsByTeam: Map<number, number[]>;
  /** Reverse: player id -> the (unique, per league) team that rosters them. */
  teamByPlayerId: Map<number, number>;
  /** Position of every rostered player. */
  positionByPlayerId: Map<number, Position>;
}

async function loadLeagueRosters(
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
async function teamStatTotals(
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
function teamValueEntries(
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

async function getStandings(ctx: AwardContext): Promise<StandingsEntry[]> {
  if (ctx.standings) return [...ctx.standings];
  if (ctx.leagueId === undefined) return [];
  return computeStandings(ctx.db, ctx.leagueId);
}

function requireLeagueId(ctx: AwardContext): number {
  if (ctx.leagueId === undefined) {
    throw new Error("league-scope award requires ctx.leagueId");
  }
  return ctx.leagueId;
}

// --- League awards (Trophy Room) --------------------------------------------

const goldenBoot: AwardDefinition = {
  id: "golden-boot",
  label: "Golden Boot",
  scope: "league",
  description: "Most goals scored by a team's rostered players.",
  unit: "goals",
  async compute(ctx) {
    const leagueId = requireLeagueId(ctx);
    const rosters = await loadLeagueRosters(ctx.db, leagueId);
    const totals = await teamStatTotals(ctx.db, leagueId, rosters, "goals");
    return teamValueEntries(totals, rosters, { limit: ctx.limit ?? DEFAULT_LIMIT });
  },
};

const playmaker: AwardDefinition = {
  id: "playmaker",
  label: "Playmaker",
  scope: "league",
  description: "Most assists by a team's rostered players.",
  unit: "assists",
  async compute(ctx) {
    const leagueId = requireLeagueId(ctx);
    const rosters = await loadLeagueRosters(ctx.db, leagueId);
    const totals = await teamStatTotals(ctx.db, leagueId, rosters, "assists");
    return teamValueEntries(totals, rosters, { limit: ctx.limit ?? DEFAULT_LIMIT });
  },
};

const goldenGlove: AwardDefinition = {
  id: "golden-glove",
  label: "Golden Glove",
  scope: "league",
  description: "Most saves by a team's rostered goalkeepers.",
  unit: "saves",
  async compute(ctx) {
    const leagueId = requireLeagueId(ctx);
    const rosters = await loadLeagueRosters(ctx.db, leagueId);
    const totals = await teamStatTotals(ctx.db, leagueId, rosters, "saves", {
      keepersOnly: true,
    });
    return teamValueEntries(totals, rosters, { limit: ctx.limit ?? DEFAULT_LIMIT });
  },
};

const highestSingleStage: AwardDefinition = {
  id: "highest-single-stage",
  label: "Stage King",
  scope: "league",
  description: "Highest best-ball points a manager scored in a single stage.",
  unit: "pts",
  async compute(ctx) {
    const entries = await getStandings(ctx);
    const rows: RawEntry[] = [];
    for (const e of entries) {
      let best = 0;
      let bestStage = "";
      for (const p of e.periods) {
        if (p.points > best) {
          best = p.points;
          bestStage = p.stage;
        }
      }
      if (best <= 0) continue;
      rows.push({
        value: round2(best),
        title: e.teamName,
        subtitle: `${STAGE_SHORT[bestStage] ?? bestStage}`,
        fantasyTeamId: e.fantasyTeamId,
        managerId: e.managerId,
        playerId: null,
      });
    }
    return rankEntries(rows, { limit: ctx.limit ?? DEFAULT_LIMIT });
  },
};

const bestSingleXi: AwardDefinition = {
  id: "best-single-xi",
  label: "Dream Team",
  scope: "league",
  description: "The single highest-scoring best-ball XI fielded in any stage.",
  unit: "pts",
  async compute(ctx) {
    const entries = await getStandings(ctx);
    const rows: RawEntry[] = [];
    for (const e of entries) {
      for (const p of e.periods) {
        if (p.points <= 0 || p.xi.length === 0) continue;
        rows.push({
          value: round2(p.points),
          title: e.teamName,
          subtitle: `${STAGE_SHORT[p.stage] ?? p.stage} - ${p.formation}`,
          fantasyTeamId: e.fantasyTeamId,
          managerId: e.managerId,
          playerId: null,
          lineup: p.xi,
        });
      }
    }
    return rankEntries(rows, { limit: ctx.limit ?? DEFAULT_LIMIT });
  },
};

const mostConsistent: AwardDefinition = {
  id: "most-consistent",
  label: "Mr. Reliable",
  scope: "league",
  description:
    "Lowest variance of per-stage best-ball points across scored stages.",
  unit: "variance",
  async compute(ctx) {
    const entries = await getStandings(ctx);
    const stages = scoredStages(entries);
    // Variance needs at least two scored stages to be meaningful.
    if (stages.length < 2) return [];
    const rows: RawEntry[] = [];
    for (const e of entries) {
      if (e.total <= 0) continue; // only teams that have actually played
      const perStage = stages.map(
        (s) => e.periods.find((p) => p.stage === s)?.points ?? 0,
      );
      const mean = perStage.reduce((a, b) => a + b, 0) / perStage.length;
      const variance =
        perStage.reduce((a, b) => a + (b - mean) * (b - mean), 0) /
        perStage.length;
      rows.push({
        value: round2(variance),
        title: e.teamName,
        subtitle: `${round2(mean)} pts/stage over ${stages.length} stages`,
        fantasyTeamId: e.fantasyTeamId,
        managerId: e.managerId,
        playerId: null,
      });
    }
    return rankEntries(rows, { ascending: true, limit: ctx.limit ?? DEFAULT_LIMIT });
  },
};

const bestDraftValue: AwardDefinition = {
  id: "best-draft-value",
  label: "Steal of the Draft",
  scope: "league",
  description:
    "Best points-per-draft-slot pick (fantasy points / average draft position).",
  unit: "pts/ADP",
  async compute(ctx) {
    const leagueId = requireLeagueId(ctx);
    const rosters = await loadLeagueRosters(ctx.db, leagueId);
    const rows: RawEntry[] = [];
    for (const [teamId, meta] of rosters.teamMeta) {
      const insights = await teamInsights(ctx.db, {
        leagueId,
        teamId,
        rulesetVersion: ctx.rulesetVersion,
      });
      const best = insights.bestValue[0];
      if (!best || best.valuePerAdp === null) continue;
      rows.push({
        value: round2(best.valuePerAdp),
        title: meta.name,
        subtitle: `${best.fullName} (${best.pointsTotal} pts, ADP ${best.adp})`,
        fantasyTeamId: teamId,
        managerId: meta.managerId,
        playerId: best.playerId,
      });
    }
    return rankEntries(rows, { limit: ctx.limit ?? DEFAULT_LIMIT });
  },
};

const bestDifferentialHaul: AwardDefinition = {
  id: "best-differential-haul",
  label: "Best Differential",
  scope: "league",
  description:
    "Most fantasy points from a low-owned (differential) rostered player.",
  unit: "pts",
  async compute(ctx) {
    const leagueId = requireLeagueId(ctx);
    const rosters = await loadLeagueRosters(ctx.db, leagueId);
    const rows: RawEntry[] = [];
    for (const [teamId, meta] of rosters.teamMeta) {
      const insights = await teamInsights(ctx.db, {
        leagueId,
        teamId,
        rulesetVersion: ctx.rulesetVersion,
      });
      const best = insights.differentials[0];
      if (!best) continue;
      const ownPct = Math.round(best.ownershipPct * 100);
      rows.push({
        value: round2(best.pointsTotal),
        title: meta.name,
        subtitle: `${best.fullName} (${ownPct}% owned)`,
        fantasyTeamId: teamId,
        managerId: meta.managerId,
        playerId: best.playerId,
      });
    }
    return rankEntries(rows, { limit: ctx.limit ?? DEFAULT_LIMIT });
  },
};

const bestHaulPerTeam: AwardDefinition = {
  id: "best-haul",
  label: "Biggest Haul",
  scope: "league",
  description:
    "Each team's biggest single-match haul by one of its rostered players.",
  unit: "pts",
  async compute(ctx) {
    const leagueId = requireLeagueId(ctx);
    const rosters = await loadLeagueRosters(ctx.db, leagueId);
    // Reuse the Phase 1 query (do NOT re-derive it). Pull the full ranked list
    // so every team's best rostered haul is present, then attribute per team.
    const hauls = await bestSingleMatchHauls(ctx.db, {
      rulesetVersion: ctx.rulesetVersion,
      limit: Number.MAX_SAFE_INTEGER,
    });
    const seen = new Set<number>();
    const rows: RawEntry[] = [];
    for (const h of hauls) {
      const teamId = rosters.teamByPlayerId.get(h.playerId);
      if (teamId === undefined || seen.has(teamId)) continue; // first = biggest
      seen.add(teamId);
      const meta = rosters.teamMeta.get(teamId);
      if (!meta) continue;
      if (h.points <= 0) continue;
      const vs = h.opponentTeamName ? ` vs ${h.opponentTeamName}` : "";
      rows.push({
        value: round2(h.points),
        title: meta.name,
        subtitle: `${h.fullName}${vs} (${STAGE_SHORT[h.stage] ?? h.stage})`,
        fantasyTeamId: teamId,
        managerId: meta.managerId,
        playerId: h.playerId,
      });
    }
    return rankEntries(rows, { limit: ctx.limit ?? DEFAULT_LIMIT });
  },
};

// --- Global awards (Stats Hub) ----------------------------------------------

function playerStatAward(
  id: string,
  label: string,
  description: string,
  metric: "goals" | "assists" | "saves",
): AwardDefinition {
  return {
    id,
    label,
    scope: "global",
    description,
    unit: metric,
    async compute(ctx) {
      const leaders = await statLeaders(ctx.db, {
        metric,
        limit: ctx.limit ?? DEFAULT_LIMIT,
      });
      const rows: RawEntry[] = leaders.map((l) => ({
        value: l.total,
        title: l.fullName,
        subtitle: l.nationalTeamName,
        fantasyTeamId: null,
        managerId: null,
        playerId: l.playerId,
      }));
      return rankEntries(rows, { limit: ctx.limit ?? DEFAULT_LIMIT });
    },
  };
}

const globalGoldenBoot = playerStatAward(
  "golden-boot",
  "Golden Boot",
  "Tournament top scorer (most goals).",
  "goals",
);
const globalPlaymaker = playerStatAward(
  "playmaker",
  "Playmaker",
  "Tournament assist leader.",
  "assists",
);
const globalGoldenGlove = playerStatAward(
  "golden-glove",
  "Golden Glove",
  "Most saves by a goalkeeper.",
  "saves",
);

const globalBestHaul: AwardDefinition = {
  id: "best-haul",
  label: "Biggest Haul",
  scope: "global",
  description: "Biggest single-match fantasy haul by any player.",
  unit: "pts",
  async compute(ctx) {
    const hauls = await bestSingleMatchHauls(ctx.db, {
      rulesetVersion: ctx.rulesetVersion,
      limit: ctx.limit ?? DEFAULT_LIMIT,
    });
    const rows: RawEntry[] = hauls.map((h) => {
      const vs = h.opponentTeamName ? ` vs ${h.opponentTeamName}` : "";
      return {
        value: round2(h.points),
        title: h.fullName,
        subtitle: `${h.nationalTeamName}${vs} (${STAGE_SHORT[h.stage] ?? h.stage})`,
        fantasyTeamId: null,
        managerId: null,
        playerId: h.playerId,
      };
    });
    return rankEntries(rows, { limit: ctx.limit ?? DEFAULT_LIMIT });
  },
};

// --- Registries + runners ----------------------------------------------------

/** Every league-scoped award, in Trophy Room display order. */
export const LEAGUE_AWARDS: readonly AwardDefinition[] = [
  goldenBoot,
  playmaker,
  goldenGlove,
  bestHaulPerTeam,
  highestSingleStage,
  bestSingleXi,
  bestDraftValue,
  bestDifferentialHaul,
  mostConsistent,
];

/** Every global (player-attributed) award, in Stats Hub display order. */
export const GLOBAL_AWARDS: readonly AwardDefinition[] = [
  globalGoldenBoot,
  globalPlaymaker,
  globalGoldenGlove,
  globalBestHaul,
];

/** All awards, both scopes. */
export const AWARDS: readonly AwardDefinition[] = [
  ...LEAGUE_AWARDS,
  ...GLOBAL_AWARDS,
];

async function computeAll(
  defs: readonly AwardDefinition[],
  ctx: AwardContext,
): Promise<AwardResult[]> {
  const results: AwardResult[] = [];
  for (const def of defs) {
    const entries = await def.compute(ctx);
    results.push({
      id: def.id,
      label: def.label,
      scope: def.scope,
      description: def.description,
      unit: def.unit,
      entries,
    });
  }
  return results;
}

export interface TrophyRoomQuery {
  leagueId: number;
  /** The league's OWN ruleset version (league.scoringRuleset.version). */
  rulesetVersion: string;
  limit?: number;
}

/**
 * Compute every league award for one league's Trophy Room. The standings
 * ladder is computed once and shared across the manager awards.
 */
export async function computeTrophyRoom(
  db: Db,
  query: TrophyRoomQuery,
): Promise<AwardResult[]> {
  const standings = await computeStandings(db, query.leagueId);
  return computeAll(LEAGUE_AWARDS, {
    db,
    leagueId: query.leagueId,
    rulesetVersion: query.rulesetVersion,
    limit: query.limit ?? 25,
    standings,
  });
}

export interface GlobalAwardsQuery {
  /** HUB_RULESET_VERSION at the call site. */
  rulesetVersion: string;
  limit?: number;
}

/** Compute every global (player-attributed) award for the Stats Hub. */
export async function computeGlobalAwards(
  db: Db,
  query: GlobalAwardsQuery,
): Promise<AwardResult[]> {
  return computeAll(GLOBAL_AWARDS, {
    db,
    rulesetVersion: query.rulesetVersion,
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
  });
}

// --- Stage labels (short) ----------------------------------------------------

const STAGE_SHORT: Record<string, string> = {
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
