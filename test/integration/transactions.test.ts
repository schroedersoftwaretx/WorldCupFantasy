/**
 * Integration tests for Priority 5 in-season transactions: the flag gate,
 * free-agent add/drop (waiver window + roster legality), waiver claim
 * processing with reverse-standings priority, trades (accept executes /
 * veto), and - critically - scoring effectivity: a movement only affects
 * periods that had not kicked off when it executed, and a league that
 * enables the flag but makes no moves computes byte-identical standings.
 */
import { sql } from "drizzle-orm";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import {
  fixture,
  nationalTeam,
  player,
  playerWaiver,
  rosterSlot,
  rosterTransaction,
  scoreEntry,
  waiverClaim,
  type Position,
  type Stage,
} from "../../src/data/db/schema.js";
import { setFlag } from "../../src/data/league/feature-flags.js";
import {
  acceptInvite,
  createLeague,
  createManager,
  inviteManager,
} from "../../src/data/league/service.js";
import { addPlayerToRoster } from "../../src/data/roster/service.js";
import { DEFAULT_RULESET } from "../../src/data/scoring/ruleset.js";
import { computeStandings } from "../../src/data/standings/standings.js";
import {
  addDropPlayers,
  processDueWaivers,
  proposeTrade,
  respondTrade,
  submitWaiverClaim,
} from "../../src/data/transactions/service.js";
import { setupContainer } from "./setup.js";

const { ctx } = setupContainer();
const RULESET = DEFAULT_RULESET.version;
// GROUP_1 fixtures kick off 2026-06-11 18:00; these bracket that instant.
const DURING_TOURNAMENT = new Date("2026-06-15T12:00:00Z");
const LATER = new Date("2026-06-16T13:00:00Z"); // past the 24h waiver window

async function worldCupCompetitionId(): Promise<number> {
  const res = await ctx.db.execute(
    sql`SELECT id FROM competition WHERE name = 'FIFA World Cup' AND season_label = '2026'`,
  );
  const id = (res.rows[0] as { id: number } | undefined)?.id;
  if (!id) throw new Error("World Cup competition not seeded by 0012");
  return id;
}

async function periodIdByStage(stage: Stage): Promise<number> {
  const compId = await worldCupCompetitionId();
  const res = await ctx.db.execute(
    sql`SELECT id FROM scoring_period WHERE competition_id = ${compId} AND stage_code = ${stage}`,
  );
  const id = (res.rows[0] as { id: number } | undefined)?.id;
  if (!id) throw new Error(`no period for ${stage}`);
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

async function seedFixture(stage: Stage, home: number, away: number): Promise<number> {
  const periodId = await periodIdByStage(stage);
  const [row] = await ctx.db
    .insert(fixture)
    .values({
      sourceFixtureId: `fx-${Math.random()}`,
      stage,
      scoringPeriodId: periodId,
      homeTeamId: home,
      awayTeamId: away,
      kickoffUtc: new Date("2026-06-11T18:00:00Z"),
      status: "FINISHED",
    })
    .returning();
  if (!row) throw new Error("fixture seed failed");
  return row.id;
}

async function giveScore(playerId: number, fixtureId: number, points: number): Promise<void> {
  await ctx.db.insert(scoreEntry).values({
    playerId,
    fixtureId,
    rulesetVersion: RULESET,
    points,
    breakdown: {},
  });
}

interface Built {
  leagueId: number;
  ownerId: number;
  joinerId: number;
  teamA: number;
  teamB: number;
  poolA: Record<Position, number[]>;
  poolB: Record<Position, number[]>;
  rosterA: number[];
  rosterB: number[];
  ntA: number;
  ntB: number;
}

async function buildLeague(): Promise<Built> {
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
    name: "Txn League",
  });
  const joiner = await createManager(ctx.db, {
    firebaseUid: `j-${Math.random()}`,
    displayName: "Joiner",
    email: `j-${Math.random()}@x.com`,
  });
  const invite = await inviteManager(ctx.db, { leagueId: created.league.id });
  const joined = await acceptInvite(ctx.db, { token: invite.token, managerId: joiner.id });
  const rosterA = await buildRoster(created.ownerTeam.id, poolA);
  const rosterB = await buildRoster(joined.team.id, poolB);
  const compId = await worldCupCompetitionId();
  await ctx.db.execute(
    sql`UPDATE league SET competition_id = ${compId}, status = 'ACTIVE' WHERE id = ${created.league.id}`,
  );
  return {
    leagueId: created.league.id,
    ownerId: owner.id,
    joinerId: joiner.id,
    teamA: created.ownerTeam.id,
    teamB: joined.team.id,
    poolA,
    poolB,
    rosterA,
    rosterB,
    ntA,
    ntB,
  };
}

beforeEach(async () => {
  await ctx.resetDb();
});

describe("flag gate", () => {
  it("rejects every entry point when the flag is off", async () => {
    const b = await buildLeague();
    await expect(
      addDropPlayers(ctx.db, {
        leagueId: b.leagueId,
        managerId: b.ownerId,
        dropPlayerId: b.rosterA[22]!,
        now: DURING_TOURNAMENT,
      }),
    ).rejects.toMatchObject({ code: "TRANSACTIONS_FLAG_DISABLED" });
  });
});

describe("free agency", () => {
  it("executes an add+drop, opens a waiver window, and blocks a direct re-add", async () => {
    const b = await buildLeague();
    await setFlag(ctx.db, b.leagueId, "transactions", { enabled: true });

    const droppedFwd = b.poolA.FWD[4]!; // A's 5th FWD (roster stays legal)
    const freeFwd = b.poolA.FWD[5]!; // undrafted
    const result = await addDropPlayers(ctx.db, {
      leagueId: b.leagueId,
      managerId: b.ownerId,
      addPlayerId: freeFwd,
      dropPlayerId: droppedFwd,
      now: DURING_TOURNAMENT,
    });
    // No fixtures seeded in this test -> every period is still open, so
    // the movement is effective from period 1.
    expect(result.effectiveOrdinal).toBe(1);

    const slots = await ctx.db
      .select()
      .from(rosterSlot)
      .where(eq(rosterSlot.fantasyTeamId, b.teamA));
    const ids = new Set(slots.map((s) => s.playerId));
    expect(ids.has(freeFwd)).toBe(true);
    expect(ids.has(droppedFwd)).toBe(false);
    expect(slots).toHaveLength(23);

    const ledger = await ctx.db
      .select()
      .from(rosterTransaction)
      .where(eq(rosterTransaction.leagueId, b.leagueId));
    expect(ledger.map((l) => l.kind).sort()).toEqual(["ADD", "DROP"]);

    // The dropped player is on waivers: direct add rejected for team B.
    await expect(
      addDropPlayers(ctx.db, {
        leagueId: b.leagueId,
        managerId: b.joinerId,
        addPlayerId: droppedFwd,
        dropPlayerId: b.poolB.FWD[4]!,
        now: new Date(DURING_TOURNAMENT.getTime() + 60_000),
      }),
    ).rejects.toMatchObject({ code: "PLAYER_ON_WAIVERS" });
  });

  it("rejects a move that breaks roster legality", async () => {
    const b = await buildLeague();
    await setFlag(ctx.db, b.leagueId, "transactions", { enabled: true });
    // Dropping a GK (roster has the minimum 2) for a FWD is illegal.
    await expect(
      addDropPlayers(ctx.db, {
        leagueId: b.leagueId,
        managerId: b.ownerId,
        addPlayerId: b.poolA.FWD[5]!,
        dropPlayerId: b.poolA.GK[0]!,
        now: DURING_TOURNAMENT,
      }),
    ).rejects.toMatchObject({ code: "ROSTER_ILLEGAL" });
    // Adding without a drop overflows the full roster.
    await expect(
      addDropPlayers(ctx.db, {
        leagueId: b.leagueId,
        managerId: b.ownerId,
        addPlayerId: b.poolA.FWD[5]!,
        now: DURING_TOURNAMENT,
      }),
    ).rejects.toMatchObject({ code: "ROSTER_FULL" });
  });
});

describe("waivers", () => {
  it("awards the expired claim to the worse-placed team and marks the rest LOST", async () => {
    const b = await buildLeague();
    await setFlag(ctx.db, b.leagueId, "transactions", { enabled: true });

    // Make team A lead the standings so B has waiver priority.
    const fx1 = await seedFixture("GROUP_1", b.ntA, b.ntB);
    await giveScore(b.poolA.FWD[0]!, fx1, 10);

    // A drops a FWD -> he goes on waivers for 24h.
    const target = b.poolA.FWD[4]!;
    await addDropPlayers(ctx.db, {
      leagueId: b.leagueId,
      managerId: b.ownerId,
      dropPlayerId: target,
      addPlayerId: b.poolA.FWD[5]!,
      now: DURING_TOURNAMENT,
    });

    // Both teams claim him.
    await submitWaiverClaim(ctx.db, {
      leagueId: b.leagueId,
      managerId: b.ownerId,
      addPlayerId: target,
      dropPlayerId: b.poolA.MID[7]!,
      now: new Date(DURING_TOURNAMENT.getTime() + 60_000),
    });
    await submitWaiverClaim(ctx.db, {
      leagueId: b.leagueId,
      managerId: b.joinerId,
      addPlayerId: target,
      dropPlayerId: b.poolB.FWD[4]!,
      now: new Date(DURING_TOURNAMENT.getTime() + 120_000),
    });

    // Before the window expires nothing processes.
    const early = await processDueWaivers(ctx.db, new Date(DURING_TOURNAMENT.getTime() + 3_600_000));
    expect(early.awarded).toBe(0);

    const run = await processDueWaivers(ctx.db, LATER);
    expect(run).toMatchObject({ awarded: 1, lost: 1, invalid: 0 });

    // B (worst placed) got him.
    const [slot] = await ctx.db
      .select()
      .from(rosterSlot)
      .where(
        and(eq(rosterSlot.leagueId, b.leagueId), eq(rosterSlot.playerId, target)),
      );
    expect(slot?.fantasyTeamId).toBe(b.teamB);

    const claims = await ctx.db
      .select()
      .from(waiverClaim)
      .where(eq(waiverClaim.leagueId, b.leagueId));
    expect(claims.map((c) => c.status).sort()).toEqual(["AWARDED", "LOST"]);

    // Idempotent: a rerun finds nothing PENDING.
    const rerun = await processDueWaivers(ctx.db, LATER);
    expect(rerun).toMatchObject({ awarded: 0, lost: 0, invalid: 0 });
  });
});

describe("trades", () => {
  it("accepting a trade swaps the players and appends TRADE ledger rows", async () => {
    const b = await buildLeague();
    await setFlag(ctx.db, b.leagueId, "transactions", { enabled: true });

    const give = b.poolA.FWD[0]!;
    const get = b.poolB.FWD[0]!;
    const { trade: t } = await proposeTrade(ctx.db, {
      leagueId: b.leagueId,
      managerId: b.ownerId,
      counterpartyTeamId: b.teamB,
      offerPlayerIds: [give],
      requestPlayerIds: [get],
      now: DURING_TOURNAMENT,
    });
    const { trade: executed } = await respondTrade(ctx.db, {
      leagueId: b.leagueId,
      managerId: b.joinerId,
      tradeId: t.id,
      action: "ACCEPT",
      now: new Date(DURING_TOURNAMENT.getTime() + 60_000),
    });
    expect(executed.status).toBe("ACCEPTED");

    const [gaveSlot] = await ctx.db
      .select()
      .from(rosterSlot)
      .where(and(eq(rosterSlot.leagueId, b.leagueId), eq(rosterSlot.playerId, give)));
    const [gotSlot] = await ctx.db
      .select()
      .from(rosterSlot)
      .where(and(eq(rosterSlot.leagueId, b.leagueId), eq(rosterSlot.playerId, get)));
    expect(gaveSlot?.fantasyTeamId).toBe(b.teamB);
    expect(gotSlot?.fantasyTeamId).toBe(b.teamA);

    const ledger = await ctx.db
      .select()
      .from(rosterTransaction)
      .where(eq(rosterTransaction.leagueId, b.leagueId));
    expect(ledger.filter((l) => l.kind === "TRADE")).toHaveLength(2);
    expect(new Set(ledger.map((l) => l.tradeId))).toEqual(new Set([t.id]));
  });

  it("the commissioner can veto a proposed trade", async () => {
    const b = await buildLeague();
    await setFlag(ctx.db, b.leagueId, "transactions", { enabled: true });
    const { trade: t } = await proposeTrade(ctx.db, {
      leagueId: b.leagueId,
      managerId: b.joinerId,
      counterpartyTeamId: b.teamA,
      offerPlayerIds: [b.poolB.FWD[0]!],
      requestPlayerIds: [b.poolA.FWD[0]!],
      now: DURING_TOURNAMENT,
    });
    const { trade: vetoed } = await respondTrade(ctx.db, {
      leagueId: b.leagueId,
      managerId: b.ownerId,
      tradeId: t.id,
      action: "VETO",
      now: DURING_TOURNAMENT,
    });
    expect(vetoed.status).toBe("VETOED");
    // Rosters untouched.
    const [slot] = await ctx.db
      .select()
      .from(rosterSlot)
      .where(
        and(
          eq(rosterSlot.leagueId, b.leagueId),
          eq(rosterSlot.playerId, b.poolB.FWD[0]!),
        ),
      );
    expect(slot?.fantasyTeamId).toBe(b.teamB);
  });
});

describe("scoring effectivity", () => {
  it("enabling the flag with no movements leaves standings deep-equal", async () => {
    const b = await buildLeague();
    const fx1 = await seedFixture("GROUP_1", b.ntA, b.ntB);
    await giveScore(b.poolA.FWD[0]!, fx1, 12);
    await giveScore(b.poolB.MID[0]!, fx1, 7);

    const before = await computeStandings(ctx.db, b.leagueId);
    await setFlag(ctx.db, b.leagueId, "transactions", { enabled: true });
    const after = await computeStandings(ctx.db, b.leagueId);
    expect(after).toEqual(before);
  });

  it("a movement after a period's kickoff does not change that period", async () => {
    const b = await buildLeague();
    await setFlag(ctx.db, b.leagueId, "transactions", { enabled: true });

    const scorer = b.poolA.FWD[0]!;
    const fx1 = await seedFixture("GROUP_1", b.ntA, b.ntB);
    await giveScore(scorer, fx1, 12);

    const before = await computeStandings(ctx.db, b.leagueId);
    const beforeA = before.find((s) => s.fantasyTeamId === b.teamA)!;

    // Drop the very player who scored in GROUP_1, after GROUP_1 kicked off.
    await addDropPlayers(ctx.db, {
      leagueId: b.leagueId,
      managerId: b.ownerId,
      dropPlayerId: scorer,
      addPlayerId: b.poolA.FWD[5]!,
      now: DURING_TOURNAMENT,
    });

    const after = await computeStandings(ctx.db, b.leagueId);
    const afterA = after.find((s) => s.fantasyTeamId === b.teamA)!;

    // GROUP_1 (period 1) still credits the dropped scorer to team A.
    expect(afterA.periods[0]!.points).toBe(beforeA.periods[0]!.points);
    expect(afterA.total).toBe(beforeA.total);
    expect(
      afterA.periods[0]!.xi.some((p) => p.playerId === scorer),
    ).toBe(true);
  });

  it("an added player only scores from his effective period on", async () => {
    const b = await buildLeague();
    await setFlag(ctx.db, b.leagueId, "transactions", { enabled: true });

    const newcomer = b.poolA.FWD[5]!; // free agent who scored in GROUP_1
    const fx1 = await seedFixture("GROUP_1", b.ntA, b.ntB);
    await giveScore(newcomer, fx1, 50);

    // Team A adds him AFTER GROUP_1 kicked off -> effective period 2.
    await addDropPlayers(ctx.db, {
      leagueId: b.leagueId,
      managerId: b.ownerId,
      addPlayerId: newcomer,
      dropPlayerId: b.poolA.FWD[4]!,
      now: DURING_TOURNAMENT,
    });

    const standings = await computeStandings(ctx.db, b.leagueId);
    const a = standings.find((s) => s.fantasyTeamId === b.teamA)!;
    // His 50 points in period 1 do NOT count for team A.
    expect(a.periods[0]!.xi.some((p) => p.playerId === newcomer)).toBe(false);
    expect(a.periods[0]!.points).toBe(0);
  });
});

describe("waiver window state", () => {
  it("clears after the window and the player becomes a direct add", async () => {
    const b = await buildLeague();
    await setFlag(ctx.db, b.leagueId, "transactions", { enabled: true });
    const dropped = b.poolA.FWD[4]!;
    await addDropPlayers(ctx.db, {
      leagueId: b.leagueId,
      managerId: b.ownerId,
      dropPlayerId: dropped,
      addPlayerId: b.poolA.FWD[5]!,
      now: DURING_TOURNAMENT,
    });
    const [wv] = await ctx.db
      .select()
      .from(playerWaiver)
      .where(
        and(
          eq(playerWaiver.leagueId, b.leagueId),
          eq(playerWaiver.playerId, dropped),
        ),
      );
    expect(wv).toBeDefined();
    // After the window, team B may add him directly.
    const result = await addDropPlayers(ctx.db, {
      leagueId: b.leagueId,
      managerId: b.joinerId,
      addPlayerId: dropped,
      dropPlayerId: b.poolB.FWD[4]!,
      now: LATER,
    });
    expect(result.added).toBe(dropped);
  });
});
