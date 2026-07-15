/**
 * Integration test for projected chip impact: with projections seeded for
 * the next period, the estimates are hand-computable; without projections
 * (or with no upcoming period) the card is null.
 */
import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { projectedChipImpact } from "../../src/data/chips/projected-impact.js";
import {
  fixture,
  league,
  nationalTeam,
  player,
  projectedScoreEntry,
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
import { setupContainer } from "./setup.js";

const { ctx } = setupContainer();
const RULESET = DEFAULT_RULESET.version;
const BEFORE_KICKOFF = new Date("2026-06-11T00:00:00Z");
const AFTER_KICKOFF = new Date("2026-06-12T00:00:00Z");

async function worldCupCompetitionId(): Promise<number> {
  const res = await ctx.db.execute(
    sql`SELECT id FROM competition WHERE name = 'FIFA World Cup' AND season_label = '2026'`,
  );
  const id = (res.rows[0] as { id: number } | undefined)?.id;
  if (!id) throw new Error("World Cup competition not seeded by 0012");
  return id;
}

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
  pick: Record<Position, number[]>,
): Promise<number[]> {
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
  return order;
}

beforeEach(async () => {
  await ctx.resetDb();
});

describe("projectedChipImpact", () => {
  it("computes base / TC / BB / SB from projections, null without them", async () => {
    const ntA = await seedNationalTeam("A");
    const ntB = await seedNationalTeam("B");
    const poolA = await seedPool(ntA);
    const owner = await createManager(ctx.db, {
      firebaseUid: `o-${Math.random()}`,
      displayName: "Owner",
      email: `o-${Math.random()}@x.com`,
    });
    const created = await createLeague(ctx.db, {
      ownerManagerId: owner.id,
      name: "Impact League",
    });
    const joiner = await createManager(ctx.db, {
      firebaseUid: `j-${Math.random()}`,
      displayName: "Joiner",
      email: `j-${Math.random()}@x.com`,
    });
    const invite = await inviteManager(ctx.db, { leagueId: created.league.id });
    await acceptInvite(ctx.db, { token: invite.token, managerId: joiner.id });
    const roster = await buildRoster(created.ownerTeam.id, poolA);
    const compId = await worldCupCompetitionId();
    await ctx.db.execute(
      sql`UPDATE league SET competition_id = ${compId} WHERE id = ${created.league.id}`,
    );
    const [lg] = await ctx.db
      .select()
      .from(league)
      .where(eq(league.id, created.league.id));

    // Upcoming GROUP_1 fixture (kickoff 6/11 18:00).
    const g1res = await ctx.db.execute(
      sql`SELECT id FROM scoring_period WHERE competition_id = ${compId} AND stage_code = 'GROUP_1'`,
    );
    const g1 = (g1res.rows[0] as { id: number }).id;
    const [fx] = await ctx.db
      .insert(fixture)
      .values({
        sourceFixtureId: `fx-${Math.random()}`,
        stage: "GROUP_1",
        scoringPeriodId: g1,
        homeTeamId: ntA,
        awayTeamId: ntB,
        kickoffUtc: new Date("2026-06-11T18:00:00Z"),
        status: "SCHEDULED",
      })
      .returning();

    // No projections yet -> null.
    expect(
      await projectedChipImpact(ctx.db, lg!, created.ownerTeam.id, BEFORE_KICKOFF),
    ).toBeNull();

    // Everyone projects 2; the first FWD projects 5 (deterministic captain).
    const star = poolA.FWD[0]!;
    for (const pid of roster) {
      await ctx.db.insert(projectedScoreEntry).values({
        playerId: pid,
        fixtureId: fx!.id,
        rulesetVersion: RULESET,
        projectedPoints: pid === star ? 5 : 2,
      });
    }

    const impact = await projectedChipImpact(
      ctx.db,
      lg!,
      created.ownerTeam.id,
      BEFORE_KICKOFF,
    );
    // Best XI = star (5) + ten 2s = 25. All 23 = 5 + 22*2 = 49.
    expect(impact).toMatchObject({
      label: "Group 1",
      base: 25,
      tripleCaptain: 5, // best projected player - no captain nominated
      captainNominated: false,
      benchBoost: 24, // 49 - 25
      stageBoost: 25,
    });
    expect(impact?.captainName).toBe("FWD-0");

    // After the period kicked off there is no upcoming period -> null.
    expect(
      await projectedChipImpact(ctx.db, lg!, created.ownerTeam.id, AFTER_KICKOFF),
    ).toBeNull();
  });
});
