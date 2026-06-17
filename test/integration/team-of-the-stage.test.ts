/**
 * Integration tests for Team of the Stage (src/data/stats/team-of-the-stage.ts).
 * Seeds a global player pool + score_entry for one stage and checks the best
 * legal XI total, formation, and the empty-stage / no-scores cases.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  fixture,
  nationalTeam,
  player,
  scoreEntry,
  statLine,
  type Position,
  type Stage,
} from "../../src/data/db/schema.js";
import { teamOfTheStage } from "../../src/data/stats/team-of-the-stage.js";
import { setupContainer } from "./setup.js";

const { ctx } = setupContainer();
const RULESET = "test-v1";

async function nt(tag: string): Promise<number> {
  const [r] = await ctx.db
    .insert(nationalTeam)
    .values({ name: `NT-${tag}`, sourceTeamId: `nt-${tag}-${Math.random()}` })
    .returning();
  return r!.id;
}
async function pl(teamId: number, position: Position, name: string): Promise<number> {
  const [r] = await ctx.db
    .insert(player)
    .values({
      fullName: name,
      position,
      nationalTeamId: teamId,
      sourcePlayerId: `p-${name}-${Math.random()}`,
    })
    .returning();
  return r!.id;
}
async function fx(stage: Stage, home: number, away: number): Promise<number> {
  const [r] = await ctx.db
    .insert(fixture)
    .values({
      sourceFixtureId: `f-${Math.random()}`,
      stage,
      homeTeamId: home,
      awayTeamId: away,
      kickoffUtc: new Date("2026-06-11T18:00:00Z"),
      status: "FINISHED",
    })
    .returning();
  return r!.id;
}
async function score(playerId: number, fixtureId: number, points: number): Promise<void> {
  await ctx.db
    .insert(scoreEntry)
    .values({ playerId, fixtureId, rulesetVersion: RULESET, points, breakdown: {} });
}

describe("teamOfTheStage (integration)", () => {
  beforeEach(async () => {
    await ctx.resetDb();
  });

  it("returns an empty result for a stage with no scores", async () => {
    const t = await nt("A");
    await fx("GROUP_1", t, t);
    const tos = await teamOfTheStage(ctx.db, { rulesetVersion: RULESET, stage: "GROUP_1" });
    expect(tos).toEqual({ stage: "GROUP_1", formation: null, points: 0, xi: [] });
  });

  it("picks the max-scoring legal XI from the global pool (5-back boundary)", async () => {
    const t = await nt("A");
    const f = await fx("GROUP_1", t, t);
    // GK 10; DEF 9x5; MID 8,8,2,1; FWD 8,8,5  -> 5-2-3 = 92 (5-back optimum).
    const spec: [Position, number][] = [
      ["GK", 10],
      ["DEF", 9], ["DEF", 9], ["DEF", 9], ["DEF", 9], ["DEF", 9],
      ["MID", 8], ["MID", 8], ["MID", 2], ["MID", 1],
      ["FWD", 8], ["FWD", 8], ["FWD", 5],
    ];
    let i = 0;
    for (const [pos, pts] of spec) {
      const pid = await pl(t, pos, `${pos}-${i++}`);
      await score(pid, f, pts);
    }
    const tos = await teamOfTheStage(ctx.db, { rulesetVersion: RULESET, stage: "GROUP_1" });
    expect(tos.points).toBe(92);
    expect(tos.formation).toBe("5-2-3");
    expect(tos.xi).toHaveLength(11);
    expect(tos.xi.filter((p) => p.position === "DEF")).toHaveLength(5);
    // The weak mids (2, 1) are excluded.
    expect(tos.xi.some((p) => p.points === 1)).toBe(false);
  });

  it("sums a player's points across multiple fixtures in the stage", async () => {
    const t = await nt("B");
    const f1 = await fx("GROUP_1", t, t);
    const f2 = await fx("GROUP_1", t, t);
    // Enough players to field a 4-3-3.
    const base: [Position, number][] = [
      ["GK", 2], ["DEF", 2], ["DEF", 2], ["DEF", 2], ["DEF", 2],
      ["MID", 2], ["MID", 2], ["MID", 2], ["FWD", 2], ["FWD", 2], ["FWD", 2],
    ];
    let i = 0;
    let starId = 0;
    for (const [pos, pts] of base) {
      const pid = await pl(t, pos, `${pos}-${i++}`);
      await score(pid, f1, pts);
      if (pos === "FWD" && starId === 0) {
        starId = pid;
        await score(pid, f2, 50); // big second game
      }
    }
    const tos = await teamOfTheStage(ctx.db, { rulesetVersion: RULESET, stage: "GROUP_1" });
    const star = tos.xi.find((p) => p.playerId === starId);
    expect(star?.points).toBe(52); // 2 + 50 across both stage fixtures
  });
});
