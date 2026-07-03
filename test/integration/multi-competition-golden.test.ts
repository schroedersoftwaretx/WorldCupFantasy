/**
 * Phase 9 golden equality test (PLAN 3.3).
 *
 * The #1 acceptance criterion: a World Cup best-ball league must compute
 * BYTE-IDENTICAL standings before and after the multi-competition backfill.
 *
 * "Before" = league.competition_id NULL and fixture.scoring_period_id NULL,
 * which exercises the stage-enum fallback path - exactly the pre-Phase-9
 * computation. "After" = league pointed at the seeded World Cup competition
 * and fixtures pointed at its scoring_period rows (what migration 0012 does
 * to the live DB). The two JSON serializations must be equal byte-for-byte.
 *
 * Also proves 0012 is idempotent by replaying its SQL against the already
 * migrated DB (the required migration dry-run evidence).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import {
  fixture,
  nationalTeam,
  player,
  scoreEntry,
  type Position,
  type Stage,
} from "../../src/data/db/schema.js";
import {
  acceptInvite,
  createLeague,
  createManager,
  inviteManager,
} from "../../src/data/league/service.js";
import { addPlayerToRoster } from "../../src/data/roster/service.js";
import { DEFAULT_RULESET } from "../../src/data/scoring/ruleset.js";
import { computeStandings } from "../../src/data/standings/standings.js";
import { setupContainer } from "./setup.js";

const { ctx } = setupContainer();
const RULESET = DEFAULT_RULESET.version;

async function seedNationalTeam(tag: string): Promise<number> {
  const [row] = await ctx.db
    .insert(nationalTeam)
    .values({ name: `NT-${tag}`, sourceTeamId: `nt-${tag}-${Math.random()}` })
    .returning();
  if (!row) throw new Error("national team seed failed");
  return row.id;
}

async function seedPool(nationalTeamId: number): Promise<Record<Position, number[]>> {
  const spec: Array<[Position, number]> = [
    ["GK", 6],
    ["DEF", 18],
    ["MID", 18],
    ["FWD", 12],
  ];
  const out: Record<Position, number[]> = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const [position, n] of spec) {
    for (let i = 0; i < n; i += 1) {
      const [row] = await ctx.db
        .insert(player)
        .values({
          fullName: `${position}-${i}`,
          position,
          nationalTeamId,
          sourcePlayerId: `p-${position}-${i}-${Math.random()}`,
        })
        .returning();
      if (row) out[position].push(row.id);
    }
  }
  return out;
}

async function buildRoster(
  teamId: number,
  pick: { GK: number[]; DEF: number[]; MID: number[]; FWD: number[] },
): Promise<void> {
  const order = [
    ...pick.GK.slice(0, 2),
    ...pick.DEF.slice(0, 6),
    ...pick.MID.slice(0, 5),
    ...pick.FWD.slice(0, 4),
    ...pick.DEF.slice(6, 8),
    ...pick.MID.slice(5, 8),
    ...pick.FWD.slice(4, 5),
  ];
  for (const playerId of order) {
    await addPlayerToRoster(ctx.db, { fantasyTeamId: teamId, playerId });
  }
}

async function seedFixture(
  sourceId: string,
  stage: Stage,
  homeTeamId: number,
  awayTeamId: number,
): Promise<number> {
  const [row] = await ctx.db
    .insert(fixture)
    .values({
      sourceFixtureId: sourceId,
      stage,
      homeTeamId,
      awayTeamId,
      kickoffUtc: new Date("2026-06-11T18:00:00Z"),
      status: "FINISHED",
    })
    .returning();
  if (!row) throw new Error("fixture seed failed");
  return row.id;
}

async function giveScore(
  playerId: number,
  fixtureId: number,
  points: number,
): Promise<void> {
  await ctx.db.insert(scoreEntry).values({
    playerId,
    fixtureId,
    rulesetVersion: RULESET,
    points,
    breakdown: {},
  });
}

/** Two managers, one league, two full legal rosters from disjoint pools. */
async function buildLeague(): Promise<{
  leagueId: number;
  poolA: Record<Position, number[]>;
  poolB: Record<Position, number[]>;
  ntA: number;
  ntB: number;
}> {
  const ntA = await seedNationalTeam("A");
  const ntB = await seedNationalTeam("B");
  const poolA = await seedPool(ntA);
  const poolB = await seedPool(ntB);

  const owner = await createManager(ctx.db, {
    firebaseUid: `o-${Math.random()}`,
    displayName: "Owner",
    email: `o-${Math.random()}@x.com`,
  });
  const created = await createLeague(ctx.db, {
    ownerManagerId: owner.id,
    name: "Golden League",
  });
  const joiner = await createManager(ctx.db, {
    firebaseUid: `j-${Math.random()}`,
    displayName: "Joiner",
    email: `j-${Math.random()}@x.com`,
  });
  const invite = await inviteManager(ctx.db, { leagueId: created.league.id });
  const joined = await acceptInvite(ctx.db, {
    token: invite.token,
    managerId: joiner.id,
  });
  await buildRoster(created.ownerTeam.id, poolA);
  await buildRoster(joined.team.id, poolB);
  return { leagueId: created.league.id, poolA, poolB, ntA, ntB };
}

/** The seeded World Cup competition id (from migration 0012's backfill). */
async function worldCupCompetitionId(): Promise<number> {
  const res = await ctx.db.execute(
    sql`SELECT id FROM competition WHERE name = 'FIFA World Cup' AND season_label = '2026'`,
  );
  const id = (res.rows[0] as { id: number } | undefined)?.id;
  if (!id) throw new Error("World Cup competition not seeded by 0012");
  return id;
}

describe("Phase 9 multi-competition golden equality", () => {
  beforeEach(async () => {
    await ctx.resetDb();
  });

  it("seeds the WC competition and its nine stage periods in order", async () => {
    const compId = await worldCupCompetitionId();
    const res = await ctx.db.execute(
      sql`SELECT ordinal, stage_code FROM scoring_period WHERE competition_id = ${compId} ORDER BY ordinal`,
    );
    const rows = res.rows as Array<{ ordinal: number; stage_code: string }>;
    expect(rows.map((r) => r.stage_code)).toEqual([
      "GROUP_1", "GROUP_2", "GROUP_3", "R32", "R16", "QF", "SF",
      "THIRD_PLACE", "FINAL",
    ]);
    expect(rows.map((r) => r.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("computes byte-identical standings before and after the backfill", async () => {
    const { leagueId, poolA, poolB, ntA, ntB } = await buildLeague();

    // Fixtures across four different stages, with varied scoring so the
    // optimizer, tie-breakers and per-period XIs all have real work to do.
    const g1 = await seedFixture("g1", "GROUP_1", ntA, ntB);
    const g2 = await seedFixture("g2", "GROUP_2", ntB, ntA);
    const r16 = await seedFixture("r16", "R16", ntA, ntB);
    const fin = await seedFixture("fin", "FINAL", ntA, ntB);

    let n = 0;
    for (const fx of [g1, g2, r16, fin]) {
      n += 1;
      for (const [i, pid] of poolA.GK.slice(0, 2).entries()) await giveScore(pid, fx, 3 + i + n);
      for (const [i, pid] of poolA.DEF.slice(0, 8).entries()) await giveScore(pid, fx, ((i * 7 + n) % 11) - 2);
      for (const [i, pid] of poolA.MID.slice(0, 8).entries()) await giveScore(pid, fx, ((i * 5 + n) % 13) - 1);
      for (const [i, pid] of poolA.FWD.slice(0, 5).entries()) await giveScore(pid, fx, ((i * 3 + n) % 9));
      for (const [i, pid] of poolB.GK.slice(0, 2).entries()) await giveScore(pid, fx, 2 + i);
      for (const [i, pid] of poolB.DEF.slice(0, 8).entries()) await giveScore(pid, fx, ((i * 4 + n) % 10) - 2);
      for (const [i, pid] of poolB.MID.slice(0, 8).entries()) await giveScore(pid, fx, ((i * 6 + n) % 12) - 3);
      for (const [i, pid] of poolB.FWD.slice(0, 5).entries()) await giveScore(pid, fx, ((i * 2 + n) % 7));
    }

    // BEFORE: no competition link anywhere -> the stage-enum fallback path,
    // which is the pre-Phase-9 computation.
    await ctx.db.execute(
      sql`UPDATE league SET competition_id = NULL WHERE id = ${leagueId}`,
    );
    await ctx.db.execute(sql`UPDATE fixture SET scoring_period_id = NULL`);
    const before = await computeStandings(ctx.db, leagueId);
    const beforeJson = JSON.stringify(before);

    // Sanity: the fallback really produced the nine stage periods.
    expect(before[0]?.periods.map((p) => p.stage)).toEqual([
      "GROUP_1", "GROUP_2", "GROUP_3", "R32", "R16", "QF", "SF",
      "THIRD_PLACE", "FINAL",
    ]);
    expect(before[0]?.total).toBeGreaterThan(0);

    // AFTER: replay migration 0012's backfill - league -> WC competition,
    // fixtures -> scoring_period rows by stage_code.
    const compId = await worldCupCompetitionId();
    await ctx.db.execute(
      sql`UPDATE league SET competition_id = ${compId} WHERE id = ${leagueId}`,
    );
    await ctx.db.execute(sql`
      UPDATE fixture f SET scoring_period_id = sp.id
      FROM scoring_period sp
      WHERE sp.competition_id = ${compId}
        AND f.scoring_period_id IS NULL
        AND sp.stage_code = f.stage
    `);
    const after = await computeStandings(ctx.db, leagueId);

    expect(JSON.stringify(after)).toBe(beforeJson);
  });

  it("defaults a new league to BEST_BALL format", async () => {
    const { leagueId } = await buildLeague();
    const res = await ctx.db.execute(
      sql`SELECT format FROM league WHERE id = ${leagueId}`,
    );
    expect((res.rows[0] as { format: string }).format).toBe("BEST_BALL");
  });

  it("migration 0012 is idempotent (re-run is a no-op)", async () => {
    const migration = readFileSync(
      join(process.cwd(), "drizzle", "0012_multi_competition.sql"),
      "utf8",
    );
    // Replay every statement against the already-migrated DB.
    for (const stmt of migration.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed.length === 0) continue;
      await ctx.db.execute(sql.raw(trimmed));
    }
    // Still exactly one competition and nine periods.
    const comps = await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM competition WHERE name = 'FIFA World Cup'`,
    );
    expect((comps.rows[0] as { n: number }).n).toBe(1);
    const periods = await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM scoring_period`,
    );
    expect((periods.rows[0] as { n: number }).n).toBe(9);
  });
});
