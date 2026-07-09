/**
 * Integration tests for the survivor pool: flag gate, join, pick rules
 * (no nation reuse, kickoff lock), derived resolution with lives and
 * elimination, missed-pick charging, and cron idempotency.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { fixture, nationalTeam } from "../../src/data/db/schema.js";
import { setFlag } from "../../src/data/league/feature-flags.js";
import {
  acceptInvite,
  createLeague,
  createManager,
  inviteManager,
} from "../../src/data/league/service.js";
import {
  getSurvivorBoard,
  joinSurvivor,
  resolveSurvivor,
  submitSurvivorPick,
} from "../../src/data/sidegames/survivor.js";
import { setupContainer } from "./setup.js";

const { ctx } = setupContainer();

const BEFORE_LOCK = new Date("2026-06-01T00:00:00Z");
const KICKOFF = new Date("2026-06-11T18:00:00Z");

async function seedTeam(name: string): Promise<number> {
  const [row] = await ctx.db
    .insert(nationalTeam)
    .values({ name, sourceTeamId: `nt-${name}-${Math.random()}` })
    .returning();
  if (!row) throw new Error("nt seed failed");
  return row.id;
}

async function seedFixture(
  stage: "GROUP_1" | "GROUP_2" | "R16" | "QF",
  home: number,
  away: number,
  hs: number | null,
  as_: number | null,
  status: "SCHEDULED" | "FINISHED",
): Promise<void> {
  await ctx.db.insert(fixture).values({
    sourceFixtureId: `fx-${Math.random()}`,
    stage,
    homeTeamId: home,
    awayTeamId: away,
    kickoffUtc: KICKOFF,
    status,
    homeScore: hs,
    awayScore: as_,
  });
}

async function buildLeague(lives = 1): Promise<{
  leagueId: number;
  ownerId: number;
  memberId: number;
}> {
  const owner = await createManager(ctx.db, {
    firebaseUid: `o-${Math.random()}`,
    displayName: "Olive",
    email: `o-${Math.random()}@x.com`,
  });
  const created = await createLeague(ctx.db, {
    ownerManagerId: owner.id,
    name: "Survivor League",
  });
  const joiner = await createManager(ctx.db, {
    firebaseUid: `j-${Math.random()}`,
    displayName: "Mia",
    email: `j-${Math.random()}@x.com`,
  });
  const invite = await inviteManager(ctx.db, { leagueId: created.league.id });
  await acceptInvite(ctx.db, { token: invite.token, managerId: joiner.id });
  await setFlag(ctx.db, created.league.id, "survivor", {
    enabled: true,
    config: { lives },
  });
  return { leagueId: created.league.id, ownerId: owner.id, memberId: joiner.id };
}

describe("survivor pool (integration)", () => {
  beforeEach(async () => {
    await ctx.resetDb();
  });

  it("gates on the flag and enforces pick rules", async () => {
    const owner = await createManager(ctx.db, {
      firebaseUid: `o-${Math.random()}`,
      displayName: "O",
      email: `o-${Math.random()}@x.com`,
    });
    const created = await createLeague(ctx.db, {
      ownerManagerId: owner.id,
      name: "No flag",
    });
    await expect(
      joinSurvivor(ctx.db, { leagueId: created.league.id, managerId: owner.id }),
    ).rejects.toMatchObject({ code: "SURVIVOR_FLAG_DISABLED" });

    const { leagueId, ownerId } = await buildLeague();
    const a = await seedTeam("Aland");
    const b = await seedTeam("Bland");
    await seedFixture("GROUP_1", a, b, null, null, "SCHEDULED");
    await seedFixture("GROUP_2", b, a, null, null, "SCHEDULED");

    // Must join first.
    await expect(
      submitSurvivorPick(ctx.db, {
        leagueId,
        managerId: ownerId,
        stage: "GROUP_1",
        nationalTeamId: a,
        now: BEFORE_LOCK,
      }),
    ).rejects.toMatchObject({ code: "NOT_ENTERED" });

    await joinSurvivor(ctx.db, { leagueId, managerId: ownerId, now: BEFORE_LOCK });
    await submitSurvivorPick(ctx.db, {
      leagueId,
      managerId: ownerId,
      stage: "GROUP_1",
      nationalTeamId: a,
      now: BEFORE_LOCK,
    });

    // No nation reuse across stages.
    await expect(
      submitSurvivorPick(ctx.db, {
        leagueId,
        managerId: ownerId,
        stage: "GROUP_2",
        nationalTeamId: a,
        now: BEFORE_LOCK,
      }),
    ).rejects.toMatchObject({ code: "NATION_ALREADY_USED" });

    // Locked at first kickoff.
    await expect(
      submitSurvivorPick(ctx.db, {
        leagueId,
        managerId: ownerId,
        stage: "GROUP_1",
        nationalTeamId: b,
        now: new Date("2026-06-11T19:00:00Z"),
      }),
    ).rejects.toMatchObject({ code: "PICK_LOCKED" });
  });

  it("resolves wins/losses, charges missed picks, eliminates, and is idempotent", async () => {
    const { leagueId, ownerId, memberId } = await buildLeague(1);
    const a = await seedTeam("Aland");
    const b = await seedTeam("Bland");
    const c = await seedTeam("Cland");
    const d = await seedTeam("Dland");

    await joinSurvivor(ctx.db, { leagueId, managerId: ownerId, now: BEFORE_LOCK });
    await joinSurvivor(ctx.db, { leagueId, managerId: memberId, now: BEFORE_LOCK });

    // Owner picks the eventual winner; member picks the loser.
    // (Fixtures inserted AFTER picks so the picks are not locked.)
    await submitSurvivorPick(ctx.db, {
      leagueId,
      managerId: ownerId,
      stage: "GROUP_1",
      nationalTeamId: a,
      now: BEFORE_LOCK,
    });
    await submitSurvivorPick(ctx.db, {
      leagueId,
      managerId: memberId,
      stage: "GROUP_1",
      nationalTeamId: b,
      now: BEFORE_LOCK,
    });
    await seedFixture("GROUP_1", a, b, 2, 0, "FINISHED");
    await seedFixture("GROUP_1", c, d, 1, 1, "FINISHED");

    const first = await resolveSurvivor(ctx.db, leagueId);
    expect(first.resolved).toBe(2);
    expect(first.eliminated).toBe(1); // member lost their only life

    // Idempotent rerun: nothing new.
    const rerun = await resolveSurvivor(ctx.db, leagueId);
    expect(rerun).toMatchObject({ resolved: 0, eliminated: 0, missedCharged: 0 });

    const board = await getSurvivorBoard(ctx.db, leagueId, ownerId);
    const ownerRow = board.find((r) => r.managerId === ownerId);
    const memberRow = board.find((r) => r.managerId === memberId);
    expect(ownerRow).toMatchObject({ livesRemaining: 1, eliminatedAtStage: null });
    expect(ownerRow?.picks[0]?.resolvedOutcome).toBe("WIN");
    expect(memberRow).toMatchObject({
      livesRemaining: 0,
      eliminatedAtStage: "GROUP_1",
    });

    // Eliminated entries cannot pick again.
    await expect(
      submitSurvivorPick(ctx.db, {
        leagueId,
        managerId: memberId,
        stage: "GROUP_2",
        nationalTeamId: c,
        now: BEFORE_LOCK,
      }),
    ).rejects.toMatchObject({ code: "ENTRY_ELIMINATED" });

    // GROUP_2 finishes with no pick from the owner -> missed-pick charge.
    await seedFixture("GROUP_2", c, d, 1, 0, "FINISHED");
    const second = await resolveSurvivor(ctx.db, leagueId);
    expect(second.missedCharged).toBe(1);
    const after = await getSurvivorBoard(ctx.db, leagueId, ownerId);
    expect(after.find((r) => r.managerId === ownerId)).toMatchObject({
      livesRemaining: 0,
      eliminatedAtStage: "GROUP_2",
    });
  });

  it("holds a level knockout pick until the next round names the winner", async () => {
    const { leagueId, ownerId } = await buildLeague(1);
    const a = await seedTeam("Aland");
    const b = await seedTeam("Bland");
    await joinSurvivor(ctx.db, { leagueId, managerId: ownerId, now: BEFORE_LOCK });
    await submitSurvivorPick(ctx.db, {
      leagueId,
      managerId: ownerId,
      stage: "R16",
      nationalTeamId: a,
      now: BEFORE_LOCK,
    });
    await seedFixture("R16", a, b, 1, 1, "FINISHED"); // decided on pens

    // Undecidable: pick stays open, no life lost.
    const pending = await resolveSurvivor(ctx.db, leagueId);
    expect(pending.resolved).toBe(0);

    // Next round is ingested: A advanced -> WIN.
    const c = await seedTeam("Cland");
    await seedFixture("QF", a, c, null, null, "SCHEDULED");
    const settled = await resolveSurvivor(ctx.db, leagueId);
    expect(settled.resolved).toBe(1);
    const board = await getSurvivorBoard(ctx.db, leagueId, ownerId);
    expect(board[0]?.picks[0]?.resolvedOutcome).toBe("WIN");
    expect(board[0]?.livesRemaining).toBe(1);
  });

  it("masks other managers' picks until the stage locks", async () => {
    const { leagueId, ownerId, memberId } = await buildLeague();
    const a = await seedTeam("Aland");
    await joinSurvivor(ctx.db, { leagueId, managerId: ownerId, now: BEFORE_LOCK });
    await submitSurvivorPick(ctx.db, {
      leagueId,
      managerId: ownerId,
      stage: "GROUP_1",
      nationalTeamId: a,
      now: BEFORE_LOCK,
    });
    // No GROUP_1 fixtures yet -> unlocked -> masked for the other member.
    const asMember = await getSurvivorBoard(ctx.db, leagueId, memberId, BEFORE_LOCK);
    const ownerRow = asMember.find((r) => r.managerId === ownerId);
    expect(ownerRow?.picks[0]).toMatchObject({ hidden: true, teamName: null });
    // The owner always sees their own.
    const asOwner = await getSurvivorBoard(ctx.db, leagueId, ownerId, BEFORE_LOCK);
    expect(asOwner.find((r) => r.managerId === ownerId)?.picks[0]?.teamName).toBe(
      "Aland",
    );
  });
});
