/**
 * Integration tests for lock reminders (phase-08 8.2): only managers with
 * something left to do are nudged, the window gates sending, and cron
 * reruns are no-ops thanks to the hub's dedupeKey suppression.
 */
import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import {
  fixture,
  nationalTeam,
  notification,
  player,
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
import { submitLineup } from "../../src/data/lineup/service.js";
import { sendLockReminders } from "../../src/data/notify/reminders.js";
import { addPlayerToRoster } from "../../src/data/roster/service.js";
import {
  joinSurvivor,
  submitSurvivorPick,
} from "../../src/data/sidegames/survivor.js";
import { setupContainer } from "./setup.js";

const { ctx } = setupContainer();
// Fixtures kick off 2026-06-11 18:00 UTC; this is 18h earlier (inside 24h).
const IN_WINDOW = new Date("2026-06-11T00:00:00Z");
// Two days out - outside the 24h window.
const TOO_EARLY = new Date("2026-06-09T12:00:00Z");

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

async function seedFixture(stage: Stage, home: number, away: number): Promise<void> {
  const periodId = await periodIdByStage(stage);
  await ctx.db.insert(fixture).values({
    sourceFixtureId: `fx-${Math.random()}`,
    stage,
    scoringPeriodId: periodId,
    homeTeamId: home,
    awayTeamId: away,
    kickoffUtc: new Date("2026-06-11T18:00:00Z"),
    status: "SCHEDULED",
  });
}

interface Built {
  leagueId: number;
  ownerId: number;
  joinerId: number;
  teamA: number;
  teamB: number;
  poolA: Record<Position, number[]>;
  ntA: number;
  ntB: number;
}

async function buildLeague(format: "BEST_BALL" | "SET_LINEUP"): Promise<Built> {
  const ntA = await seedNationalTeam("A");
  const ntB = await seedNationalTeam("B");
  const poolA = await seedPool(ntA);
  const poolB = await seedPool(ntB);
  const owner = await createManager(ctx.db, {
    firebaseUid: `o-${Math.random()}`,
    displayName: "Owner",
    email: `o-${Math.random()}@x.com`,
  });
  const compId = await worldCupCompetitionId();
  const created = await createLeague(ctx.db, {
    ownerManagerId: owner.id,
    name: "Reminder League",
    ...(format === "SET_LINEUP" ? { format, competitionId: compId } : {}),
  });
  const joiner = await createManager(ctx.db, {
    firebaseUid: `j-${Math.random()}`,
    displayName: "Joiner",
    email: `j-${Math.random()}@x.com`,
  });
  const invite = await inviteManager(ctx.db, { leagueId: created.league.id });
  const joined = await acceptInvite(ctx.db, { token: invite.token, managerId: joiner.id });
  await buildRoster(created.ownerTeam.id, poolA);
  await buildRoster(joined.team.id, poolB);
  await ctx.db.execute(
    sql`UPDATE league SET competition_id = ${compId}, status = 'ACTIVE' WHERE id = ${created.league.id}`,
  );
  // resetDb truncates players/fixtures but leagues survive (no FK cascade
  // reaches them); park leftovers so the cron sweep only sees this league.
  await ctx.db.execute(
    sql`UPDATE league SET status = 'SETUP' WHERE id != ${created.league.id}`,
  );
  return {
    leagueId: created.league.id,
    ownerId: owner.id,
    joinerId: joiner.id,
    teamA: created.ownerTeam.id,
    teamB: joined.team.id,
    poolA,
    ntA,
    ntB,
  };
}

async function reminderRows() {
  return (
    await ctx.db.select().from(notification)
  ).filter((n) => n.type === "LOCK_REMINDER");
}

beforeEach(async () => {
  await ctx.resetDb();
});

describe("lineup lock reminders", () => {
  it("nudges only teams without a submitted lineup, once", async () => {
    const b = await buildLeague("SET_LINEUP");
    await seedFixture("GROUP_1", b.ntA, b.ntB);

    // Owner submits an XI for GROUP_1; joiner does not.
    const g1 = await periodIdByStage("GROUP_1");
    const xi = [
      ...b.poolA.GK.slice(0, 1),
      ...b.poolA.DEF.slice(0, 5),
      ...b.poolA.MID.slice(0, 3),
      ...b.poolA.FWD.slice(0, 2),
    ];
    await submitLineup(ctx.db, {
      fantasyTeamId: b.teamA,
      scoringPeriodId: g1,
      playerIds: xi,
      captainPlayerId: xi[0]!,
      now: IN_WINDOW,
    });

    // Outside the window: nothing.
    const early = await sendLockReminders(ctx.db, TOO_EARLY);
    expect(early.lineupReminders).toBe(0);

    const run = await sendLockReminders(ctx.db, IN_WINDOW);
    expect(run.lineupReminders).toBe(1);
    const rows = await reminderRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.managerId).toBe(b.joinerId);
    expect(rows[0]?.link).toBe(`/leagues/${b.leagueId}/lineup`);

    // Cron rerun: deduped, no new rows.
    const rerun = await sendLockReminders(ctx.db, IN_WINDOW);
    expect(rerun.lineupReminders).toBe(0);
    expect(await reminderRows()).toHaveLength(1);
  });
});

describe("survivor pick reminders", () => {
  it("nudges alive entrants without a pick for the upcoming stage", async () => {
    const b = await buildLeague("BEST_BALL");
    await setFlag(ctx.db, b.leagueId, "survivor", { enabled: true });
    await seedFixture("GROUP_1", b.ntA, b.ntB);

    await joinSurvivor(ctx.db, { leagueId: b.leagueId, managerId: b.ownerId });
    await joinSurvivor(ctx.db, { leagueId: b.leagueId, managerId: b.joinerId });
    // Owner picks; joiner forgets.
    await submitSurvivorPick(ctx.db, {
      leagueId: b.leagueId,
      managerId: b.ownerId,
      stage: "GROUP_1",
      nationalTeamId: b.ntA,
      now: IN_WINDOW,
    });

    const run = await sendLockReminders(ctx.db, IN_WINDOW);
    expect(run.survivorReminders).toBe(1);
    const rows = await reminderRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.managerId).toBe(b.joinerId);
    expect(rows[0]?.link).toBe(`/leagues/${b.leagueId}/survivor`);

    const rerun = await sendLockReminders(ctx.db, IN_WINDOW);
    expect(rerun.survivorReminders).toBe(0);
  });

  it("sends nothing for a league with neither trigger", async () => {
    const b = await buildLeague("BEST_BALL");
    await seedFixture("GROUP_1", b.ntA, b.ntB);
    const run = await sendLockReminders(ctx.db, IN_WINDOW);
    expect(run.lineupReminders + run.survivorReminders).toBe(0);
    expect(await reminderRows()).toHaveLength(0);
  });
});
