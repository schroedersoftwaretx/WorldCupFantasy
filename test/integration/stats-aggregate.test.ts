/**
 * Integration tests for the Phase 0 stats aggregate layer
 * (src/data/stats/aggregate.ts). Seeds fixtures + score_entry + stat_line and
 * checks the top-scorer / per-fixture / stat-leader shapes against known data.
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
import {
  perFixturePlayerPoints,
  statLeaders,
  topScorers,
} from "../../src/data/stats/aggregate.js";
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
async function stat(
  playerId: number,
  fixtureId: number,
  vals: { goals?: number; assists?: number; saves?: number; minutesPlayed?: number },
): Promise<void> {
  await ctx.db
    .insert(statLine)
    .values({ playerId, fixtureId, sourceRevision: "r1", ...vals });
}

describe("stats aggregate (integration)", () => {
  beforeEach(async () => {
    await ctx.resetDb();
  });

  it("topScorers totals score_entry points per player and ranks them", async () => {
    const team = await nt("A");
    const striker = await pl(team, "FWD", "Striker");
    const mid = await pl(team, "MID", "Mid");
    const f1 = await fx("GROUP_1", team, team);
    const f2 = await fx("GROUP_2", team, team);
    await score(striker, f1, 5);
    await score(striker, f2, 4); // 9 over 2 appearances
    await score(mid, f1, 7); // 7 over 1

    const top = await topScorers(ctx.db, { rulesetVersion: RULESET });
    expect(top.map((t) => [t.playerId, t.points, t.appearances])).toEqual([
      [striker, 9, 2],
      [mid, 7, 1],
    ]);
    expect(top[0]!.nationalTeamName).toBe("NT-A");

    const g1 = await topScorers(ctx.db, { rulesetVersion: RULESET, stage: "GROUP_1" });
    expect(g1.map((t) => [t.playerId, t.points])).toEqual([
      [mid, 7],
      [striker, 5],
    ]);
  });

  it("topScorers ignores other rulesets", async () => {
    const team = await nt("B");
    const p = await pl(team, "FWD", "X");
    const f = await fx("GROUP_1", team, team);
    await score(p, f, 5);
    expect(await topScorers(ctx.db, { rulesetVersion: "other" })).toEqual([]);
  });

  it("perFixturePlayerPoints returns per-player points for one fixture", async () => {
    const team = await nt("C");
    const a = await pl(team, "FWD", "A");
    const b = await pl(team, "DEF", "B");
    const f = await fx("R16", team, team);
    await score(a, f, 3);
    await score(b, f, 6);
    const rows = await perFixturePlayerPoints(ctx.db, RULESET, f);
    expect(rows.map((r) => [r.playerId, r.points])).toEqual([
      [b, 6],
      [a, 3],
    ]);
  });

  it("statLeaders totals raw stats from stat_line", async () => {
    const team = await nt("D");
    const a = await pl(team, "FWD", "A");
    const b = await pl(team, "MID", "B");
    const f1 = await fx("GROUP_1", team, team);
    const f2 = await fx("GROUP_2", team, team);
    await stat(a, f1, { goals: 2 });
    await stat(a, f2, { goals: 1, assists: 1 }); // 3 goals total
    await stat(b, f1, { goals: 1, assists: 2 }); // 1 goal, 2 assists

    expect(
      (await statLeaders(ctx.db, { metric: "goals" })).map((g) => [g.playerId, g.total]),
    ).toEqual([
      [a, 3],
      [b, 1],
    ]);
    expect(
      (await statLeaders(ctx.db, { metric: "assists" })).map((g) => [g.playerId, g.total]),
    ).toEqual([
      [b, 2],
      [a, 1],
    ]);
    expect(
      (await statLeaders(ctx.db, { metric: "goals", stage: "GROUP_1" })).map((g) => [
        g.playerId,
        g.total,
      ]),
    ).toEqual([
      [a, 2],
      [b, 1],
    ]);
  });
});
