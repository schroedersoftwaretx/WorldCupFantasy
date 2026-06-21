/**
 * Integration tests for the Stats Hub Player Explorer:
 *   - src/data/stats/player-explorer.ts (filter by position/nation, sort)
 *   - src/data/standings/player-breakdown.ts#getPlayerBreakdownForRuleset
 *     (the public, ruleset-versioned breakdown behind the player modal)
 *
 * Seed (ruleset "test-v1"), two nations Spain & Brazil:
 *   pedri    MID ESP  pts 10+5=15  app2  goals1 assists3 min180
 *   rodri    MID ESP  pts 8        app1  goals2 assists1 min90
 *   vini     FWD BRA  pts 20       app1  goals3           min90
 *   keeperE  GK  ESP  pts 6        app1  saves5           min90
 *   statOnly DEF BRA  pts 0 (no score_entry)  min45   <- union still lists it
 */
import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

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
  playerExplorer,
  playerExplorerNations,
} from "../../src/data/stats/player-explorer.js";
import { getPlayerBreakdownForRuleset } from "../../src/data/standings/player-breakdown.js";
import { setupContainer } from "./setup.js";

const { ctx } = setupContainer();
const RULESET = "test-v1";

async function nt(name: string): Promise<number> {
  const [r] = await ctx.db
    .insert(nationalTeam)
    .values({ name, sourceTeamId: `nt-${name}-${Math.random()}` })
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
async function fx(
  home: number,
  away: number,
  stage: Stage,
  kickoffIso = "2026-06-11T18:00:00Z",
): Promise<number> {
  const [r] = await ctx.db
    .insert(fixture)
    .values({
      sourceFixtureId: `f-${Math.random()}`,
      stage,
      homeTeamId: home,
      awayTeamId: away,
      kickoffUtc: new Date(kickoffIso),
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
  v: {
    goals?: number;
    assists?: number;
    saves?: number;
    minutesPlayed?: number;
    keyPasses?: number;
    bigChancesCreated?: number;
  },
): Promise<void> {
  await ctx.db.insert(statLine).values({
    playerId,
    fixtureId,
    goals: v.goals ?? 0,
    assists: v.assists ?? 0,
    saves: v.saves ?? 0,
    minutesPlayed: v.minutesPlayed ?? 0,
    keyPasses: v.keyPasses ?? 0,
    bigChancesCreated: v.bigChancesCreated ?? 0,
    sourceRevision: "test",
  });
}

interface World {
  pedri: number;
  rodri: number;
  vini: number;
  keeperE: number;
  statOnly: number;
  esp: number;
  bra: number;
}

async function seed(): Promise<World> {
  const esp = await nt("Spain");
  const bra = await nt("Brazil");
  const f1 = await fx(esp, bra, "GROUP_1", "2026-06-11T18:00:00Z");
  const f2 = await fx(esp, bra, "GROUP_2", "2026-06-15T18:00:00Z");

  const pedri = await pl(esp, "MID", "Pedri");
  const rodri = await pl(esp, "MID", "Rodri");
  const vini = await pl(bra, "FWD", "Vinicius");
  const keeperE = await pl(esp, "GK", "Simon");
  const statOnly = await pl(bra, "DEF", "Marquinhos");

  await score(pedri, f1, 10);
  await score(pedri, f2, 5);
  await score(rodri, f1, 8);
  await score(vini, f1, 20);
  await score(keeperE, f1, 6);

  await stat(pedri, f1, { goals: 1, assists: 2, minutesPlayed: 90, keyPasses: 3, bigChancesCreated: 1 });
  await stat(pedri, f2, { assists: 1, minutesPlayed: 90 });
  await stat(rodri, f1, { goals: 2, assists: 1, minutesPlayed: 90, keyPasses: 1, bigChancesCreated: 2 });
  await stat(vini, f1, { goals: 3, minutesPlayed: 90 });
  await stat(keeperE, f1, { saves: 5, minutesPlayed: 90 });
  await stat(statOnly, f1, { minutesPlayed: 45 });

  return { pedri, rodri, vini, keeperE, statOnly, esp, bra };
}

describe("player explorer (filter + sort)", () => {
  beforeEach(async () => {
    await ctx.db.execute(
      sql`TRUNCATE TABLE manager, league, fantasy_team, league_membership, league_invite, draft_room, draft_order, draft_pick, roster_slot, standings_snapshot, score_entry, stat_line, fixture, player, national_team, notification, league_feature_flag RESTART IDENTITY CASCADE`,
    );
  });

  it("default sort is fantasy points desc, over the union of scored+stat players", async () => {
    const w = await seed();
    const rows = await playerExplorer(ctx.db, { rulesetVersion: RULESET });
    expect(rows.map((r) => [r.playerId, r.points])).toEqual([
      [w.vini, 20],
      [w.pedri, 15],
      [w.rodri, 8],
      [w.keeperE, 6],
      [w.statOnly, 0],
    ]);
    const pedri = rows.find((r) => r.playerId === w.pedri)!;
    expect(pedri).toMatchObject({ appearances: 2, goals: 1, assists: 3, minutesPlayed: 180 });
  });

  it("filters to highest-scoring midfielders", async () => {
    const w = await seed();
    const rows = await playerExplorer(ctx.db, { rulesetVersion: RULESET, position: "MID" });
    expect(rows.map((r) => r.playerId)).toEqual([w.pedri, w.rodri]);
    expect(rows.every((r) => r.position === "MID")).toBe(true);
  });

  it("filters to one nation (highest-scoring Spaniards)", async () => {
    const w = await seed();
    const rows = await playerExplorer(ctx.db, {
      rulesetVersion: RULESET,
      nationalTeamId: w.esp,
    });
    expect(rows.map((r) => r.playerId)).toEqual([w.pedri, w.rodri, w.keeperE]);
  });

  it("sorts by a raw stat, breaking ties by fantasy points", async () => {
    const w = await seed();
    const rows = await playerExplorer(ctx.db, { rulesetVersion: RULESET, sort: "goals" });
    // goals: vini3, rodri2, pedri1, then keeperE0 & statOnly0 -> points tiebreak.
    expect(rows.map((r) => r.playerId)).toEqual([
      w.vini,
      w.rodri,
      w.pedri,
      w.keeperE,
      w.statOnly,
    ]);

    const mids = await playerExplorer(ctx.db, {
      rulesetVersion: RULESET,
      position: "MID",
      sort: "assists",
    });
    expect(mids.map((r) => [r.playerId, r.assists])).toEqual([
      [w.pedri, 3],
      [w.rodri, 1],
    ]);
  });

  it("sorts by the new playmaking columns (key passes, big chances created)", async () => {
    const w = await seed();
    const byKp = await playerExplorer(ctx.db, {
      rulesetVersion: RULESET,
      position: "MID",
      sort: "keyPasses",
    });
    expect(byKp.map((r) => [r.playerId, r.keyPasses])).toEqual([
      [w.pedri, 3],
      [w.rodri, 1],
    ]);

    const byBcc = await playerExplorer(ctx.db, {
      rulesetVersion: RULESET,
      position: "MID",
      sort: "bigChancesCreated",
    });
    expect(byBcc.map((r) => [r.playerId, r.bigChancesCreated])).toEqual([
      [w.rodri, 2],
      [w.pedri, 1],
    ]);
  });

  it("lists nations that have tournament data, sorted by name", async () => {
    await seed();
    const nations = await playerExplorerNations(ctx.db, RULESET);
    expect(nations.map((n) => n.name)).toEqual(["Brazil", "Spain"]);
  });

  it("public breakdown is ruleset-versioned and lists per-fixture totals", async () => {
    const w = await seed();
    const bd = await getPlayerBreakdownForRuleset(ctx.db, RULESET, w.pedri);
    expect(bd).not.toBeNull();
    expect(bd!.fixtures.map((f) => f.total)).toEqual([10, 5]); // kickoff order
    const missing = await getPlayerBreakdownForRuleset(ctx.db, RULESET, 999999);
    expect(missing).toBeNull();
  });
});
