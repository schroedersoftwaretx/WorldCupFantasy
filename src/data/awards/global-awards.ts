/**
 * Global (player-attributed) award definitions for the Stats Hub, Phase 7.1.
 *
 * Split out of registry.ts (tech-debt #3). Scoring logic preserved
 * byte-for-byte; only `export` was added so the registry barrel can assemble
 * GLOBAL_AWARDS. The `playerStatAward` factory stays module-private.
 */
import { bestSingleMatchHauls, statLeaders } from "../stats/aggregate.js";
import type { AwardDefinition } from "./types.js";
import {
  DEFAULT_LIMIT,
  rankEntries,
  round2,
  STAGE_SHORT,
  type RawEntry,
} from "./helpers.js";

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

export const globalGoldenBoot = playerStatAward(
  "golden-boot",
  "Golden Boot",
  "Tournament top scorer (most goals).",
  "goals",
);
export const globalPlaymaker = playerStatAward(
  "playmaker",
  "Playmaker",
  "Tournament assist leader.",
  "assists",
);
export const globalGoldenGlove = playerStatAward(
  "golden-glove",
  "Golden Glove",
  "Most saves by a goalkeeper.",
  "saves",
);

export const globalBestHaul: AwardDefinition = {
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
