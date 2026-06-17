/**
 * Integration tests for the Phase 1 leaderboard/records extensions to
 * src/data/stats/aggregate.ts and the src/data/stats/hub.ts composition.
 * Totals are checked against hand-computed values from seeded data.
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
  bestSingleMatchHauls,
  latestStageWithScores,
  nationStatLeaders,
  playerForm,
  positionScarcity,
  stagesWithScores,
  topScorers,
} from "../../src/data/stats/aggregate.js";
import { getLeaderboards, getRecords } from "../../src/data/stats/hub.js";
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
async function fx(stage: Stage, home: number, away: number, kickoff: string): Promise<number> {
  const [r] = await ctx.db
    .insert(fixture)
    .values({
      sourceFixtureId: `f-${Math.random()}`,
      stage,
      homeTeamId: home,
      awayTeamId: away,
      kickoffUtc: new Date(kickoff),
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

describe("stats leaderboards + records (integration)", () => {
  beforeEach(async () => {
    await ctx.resetDb();
  });

  it("topScorers filters by position", async () => {
    const t = await nt("A");
    const fwd = await pl(t, "FWD", "Fwd");
    const def = await pl(t, "DEF", "Def");
    const f = await fx("GROUP_1", t, t, "2026-06-11T18:00:00Z");
    await score(fwd, f, 9);
    await score(def, f, 7);
    const fwds = await topScorers(ctx.db, { rulesetVersion: RULESET, position: "FWD" });
    expect(fwds.map((r) => r.playerId)).toEqual([fwd]);
    const defs = await topScorers(ctx.db, { rulesetVersion: RULESET, position: "DEF" });
    expect(defs.map((r) => r.playerId)).toEqual([def]);
  });

  it("playerForm totals the last N featured fixtures by kickoff", async () => {
    const t = await nt("B");
    const p = await pl(t, "MID", "Mid");
    const f1 = await fx("GROUP_1", t, t, "2026-06-11T18:00:00Z");
    const f2 = await fx("GROUP_2", t, t, "2026-06-15T18:00:00Z");
    const f3 = await fx("GROUP_3", t, t, "2026-06-19T18:00:00Z");
    await score(p, f1, 2); // oldest - excluded when lastN=2
    await score(p, f2, 5);
    await score(p, f3, 8);
    const form = await playerForm(ctx.db, { rulesetVersion: RULESET, lastN: 2 });
    expect(form[0]!.playerId).toBe(p);
    expect(form[0]!.points).toBe(13); // 5 + 8 (two most recent)
    expect(form[0]!.appearances).toBe(2);
  });

  it("bestSingleMatchHauls ranks single score_entry rows with opponent", async () => {
    const home = await nt("H");
    const away = await nt("Aw");
    const star = await pl(home, "FWD", "Star");
    const other = await pl(away, "MID", "Other");
    const f = await fx("R16", home, away, "2026-07-01T18:00:00Z");
    await score(star, f, 18);
    await score(other, f, 6);
    const hauls = await bestSingleMatchHauls(ctx.db, { rulesetVersion: RULESET });
    expect(hauls[0]!.playerId).toBe(star);
    expect(hauls[0]!.points).toBe(18);
    expect(hauls[0]!.stage).toBe("R16");
    expect(hauls[0]!.opponentTeamId).toBe(away);
    expect(hauls[0]!.opponentTeamName).toBe("NT-Aw");
  });

  it("nationStatLeaders aggregates raw goals to the national team", async () => {
    const a = await nt("A");
    const b = await nt("B");
    const a1 = await pl(a, "FWD", "A1");
    const a2 = await pl(a, "MID", "A2");
    const b1 = await pl(b, "FWD", "B1");
    const f = await fx("GROUP_1", a, b, "2026-06-11T18:00:00Z");
    await stat(a1, f, { goals: 2 });
    await stat(a2, f, { goals: 1 });
    await stat(b1, f, { goals: 2 });
    const nations = await nationStatLeaders(ctx.db, { metric: "goals" });
    expect(nations.map((n) => [n.nationalTeamId, n.total])).toEqual([
      [a, 3],
      [b, 2],
    ]);
  });

  it("positionScarcity averages points by (stage, position)", async () => {
    const t = await nt("A");
    const d1 = await pl(t, "DEF", "D1");
    const d2 = await pl(t, "DEF", "D2");
    const m1 = await pl(t, "MID", "M1");
    const f = await fx("GROUP_1", t, t, "2026-06-11T18:00:00Z");
    await score(d1, f, 4);
    await score(d2, f, 6); // DEF avg = 5
    await score(m1, f, 8); // MID avg = 8
    const cells = await positionScarcity(ctx.db, RULESET);
    const def = cells.find((c) => c.position === "DEF" && c.stage === "GROUP_1");
    const mid = cells.find((c) => c.position === "MID" && c.stage === "GROUP_1");
    expect(def?.avgPoints).toBe(5);
    expect(def?.entries).toBe(2);
    expect(mid?.avgPoints).toBe(8);
  });

  it("stage discovery reports scored stages in tournament order", async () => {
    const t = await nt("A");
    const p = await pl(t, "FWD", "P");
    const fG1 = await fx("GROUP_1", t, t, "2026-06-11T18:00:00Z");
    const fR16 = await fx("R16", t, t, "2026-07-01T18:00:00Z");
    await score(p, fG1, 3);
    await score(p, fR16, 5);
    expect(await stagesWithScores(ctx.db, RULESET)).toEqual(["GROUP_1", "R16"]);
    expect(await latestStageWithScores(ctx.db, RULESET)).toBe("R16");
  });

  it("getLeaderboards and getRecords compose the hub payloads", async () => {
    const t = await nt("A");
    const f = await fx("GROUP_1", t, t, "2026-06-11T18:00:00Z");
    // Field a full legal XI plus a high scorer.
    const spec: [Position, number][] = [
      ["GK", 6], ["DEF", 5], ["DEF", 5], ["DEF", 5], ["DEF", 5],
      ["MID", 4], ["MID", 4], ["MID", 4], ["FWD", 9], ["FWD", 3], ["FWD", 3],
    ];
    let i = 0;
    for (const [pos, pts] of spec) {
      const pid = await pl(t, pos, `${pos}-${i++}`);
      await score(pid, f, pts);
      await stat(pid, f, { goals: pos === "FWD" ? 1 : 0 });
    }
    const lb = await getLeaderboards(ctx.db, { rulesetVersion: RULESET });
    expect(lb.topScorers[0]!.points).toBe(9);
    expect(lb.byPosition.FWD[0]!.points).toBe(9);
    expect(lb.byPosition.GK[0]!.points).toBe(6);
    expect(lb.bestHauls[0]!.points).toBe(9);
    expect(lb.statLeaders.goals[0]!.total).toBe(1);

    const rec = await getRecords(ctx.db, { rulesetVersion: RULESET });
    expect(rec.highestScoringXi).not.toBeNull();
    expect(rec.highestScoringXi!.stage).toBe("GROUP_1");
    expect(rec.biggestHaul!.points).toBe(9);
    expect(rec.topNationsByGoals[0]!.total).toBe(3); // 3 FWDs x 1 goal
    expect(rec.positionScarcity.length).toBeGreaterThan(0);
  });
});
