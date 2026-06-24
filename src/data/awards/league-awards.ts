/**
 * League-scoped award definitions (the Trophy Room), Phase 7.1.
 *
 * Split out of registry.ts (tech-debt #3). Each award's scoring logic is
 * preserved byte-for-byte; only `export` was added to the definitions so the
 * registry barrel can assemble LEAGUE_AWARDS.
 */
import { bestSingleMatchHauls } from "../stats/aggregate.js";
import { teamInsights } from "../stats/differentials.js";
import { scoredStages } from "../standings/snapshot.js";
import type { AwardDefinition } from "./types.js";
import {
  DEFAULT_LIMIT,
  getStandings,
  loadLeagueRosters,
  rankEntries,
  requireLeagueId,
  round2,
  STAGE_SHORT,
  teamStatTotals,
  teamValueEntries,
  type RawEntry,
} from "./helpers.js";

// --- League awards (Trophy Room) --------------------------------------------

export const goldenBoot: AwardDefinition = {
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

export const playmaker: AwardDefinition = {
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

export const goldenGlove: AwardDefinition = {
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

export const highestSingleStage: AwardDefinition = {
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

export const bestSingleXi: AwardDefinition = {
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

export const mostConsistent: AwardDefinition = {
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

export const bestDraftValue: AwardDefinition = {
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

export const bestDifferentialHaul: AwardDefinition = {
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

export const bestHaulPerTeam: AwardDefinition = {
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
