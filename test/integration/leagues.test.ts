/**
 * Integration tests for the Phase 3 league + roster services.
 *
 * Exercises the real DB: manager upsert, league creation (with the
 * owner's membership + team created in the same transaction), the
 * token-based invite/accept flow, max_managers enforcement, and the
 * roster service - including the two rejections that matter most:
 * drafting a player already taken in the league, and drafting a player
 * that would make a legal 23-man roster impossible.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { player } from "../../src/data/db/schema.js";
import { ingestSquads } from "../../src/data/ingest/squads.js";
import {
  acceptInvite,
  createLeague,
  createManager,
  inviteManager,
  revokeInvite,
} from "../../src/data/league/service.js";
import { LeagueError, RosterError } from "../../src/data/league/errors.js";
import { FixtureMockProvider } from "../../src/data/provider/mock.js";
import { addPlayerToRoster, getRosterCounts } from "../../src/data/roster/service.js";
import { setupContainer } from "./setup.js";

const FIXTURES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "provider",
);

const { ctx } = setupContainer();

describe("Phase 3 leagues + rosters (integration)", () => {
  beforeEach(async () => {
    await ctx.resetDb();
  });

  it("createManager upserts by firebase uid (idempotent)", async () => {
    const a = await createManager(ctx.db, {
      firebaseUid: "uid-1",
      displayName: "Aidan",
      email: "aidan@example.com",
    });
    const b = await createManager(ctx.db, {
      firebaseUid: "uid-1",
      displayName: "Aidan",
      email: "aidan@example.com",
    });
    expect(b.id).toBe(a.id);

    // Same uid, changed name -> updates in place, same row id.
    const c = await createManager(ctx.db, {
      firebaseUid: "uid-1",
      displayName: "Aidan S.",
      email: "aidan@example.com",
    });
    expect(c.id).toBe(a.id);
    expect(c.displayName).toBe("Aidan S.");
  });

  it("createLeague also creates the owner's membership + team in one go", async () => {
    const owner = await createManager(ctx.db, {
      firebaseUid: "owner",
      displayName: "Owner",
      email: "owner@example.com",
    });
    const result = await createLeague(ctx.db, {
      ownerManagerId: owner.id,
      name: "Test League",
    });
    expect(result.league.status).toBe("SETUP");
    expect(result.league.maxManagers).toBe(24);
    expect(result.ownerMembership.role).toBe("OWNER");
    expect(result.ownerTeam.managerId).toBe(owner.id);
    // The league embeds the default scoring ruleset.
    const ruleset = result.league.scoringRuleset as { version?: string };
    expect(typeof ruleset.version).toBe("string");
  });

  it("rejects an out-of-range maxManagers", async () => {
    const owner = await createManager(ctx.db, {
      firebaseUid: "owner2",
      displayName: "Owner2",
      email: "o2@example.com",
    });
    await expect(
      createLeague(ctx.db, { ownerManagerId: owner.id, name: "Bad", maxManagers: 1 }),
    ).rejects.toBeInstanceOf(LeagueError);
    await expect(
      createLeague(ctx.db, { ownerManagerId: owner.id, name: "Bad", maxManagers: 25 }),
    ).rejects.toBeInstanceOf(LeagueError);
  });

  it("invite + accept adds a member with their own team", async () => {
    const owner = await createManager(ctx.db, {
      firebaseUid: "owner3",
      displayName: "Owner3",
      email: "o3@example.com",
    });
    const { league } = await createLeague(ctx.db, {
      ownerManagerId: owner.id,
      name: "Joinable",
    });
    const joiner = await createManager(ctx.db, {
      firebaseUid: "joiner",
      displayName: "Joiner",
      email: "joiner@example.com",
    });

    const invite = await inviteManager(ctx.db, { leagueId: league.id });
    const result = await acceptInvite(ctx.db, {
      token: invite.token,
      managerId: joiner.id,
    });
    expect(result.membership.role).toBe("MEMBER");
    expect(result.team.managerId).toBe(joiner.id);
  });

  it("a shareable (non-email) token is multi-use across managers", async () => {
    const owner = await createManager(ctx.db, {
      firebaseUid: "owner4",
      displayName: "Owner4",
      email: "o4@example.com",
    });
    const { league } = await createLeague(ctx.db, {
      ownerManagerId: owner.id,
      name: "Once",
    });
    const j1 = await createManager(ctx.db, {
      firebaseUid: "j1",
      displayName: "J1",
      email: "j1@example.com",
    });
    const j2 = await createManager(ctx.db, {
      firebaseUid: "j2",
      displayName: "J2",
      email: "j2@example.com",
    });
    const invite = await inviteManager(ctx.db, { leagueId: league.id });
    // The same link works for several people.
    await acceptInvite(ctx.db, { token: invite.token, managerId: j1.id });
    const second = await acceptInvite(ctx.db, {
      token: invite.token,
      managerId: j2.id,
    });
    expect(second.membership.managerId).toBe(j2.id);
    // But the same manager can't redeem it twice.
    await expect(
      acceptInvite(ctx.db, { token: invite.token, managerId: j1.id }),
    ).rejects.toBeInstanceOf(LeagueError);
  });

  it("a targeted (email) invite is single-use", async () => {
    const owner = await createManager(ctx.db, {
      firebaseUid: "owner4b",
      displayName: "Owner4b",
      email: "o4b@example.com",
    });
    const { league } = await createLeague(ctx.db, {
      ownerManagerId: owner.id,
      name: "OnceTargeted",
    });
    const j1 = await createManager(ctx.db, {
      firebaseUid: "j1b",
      displayName: "J1b",
      email: "j1b@example.com",
    });
    const invite = await inviteManager(ctx.db, {
      leagueId: league.id,
      email: "j1b@example.com",
    });
    await acceptInvite(ctx.db, { token: invite.token, managerId: j1.id });
    // Consumed: even the same recipient can't reuse it (now ACCEPTED).
    await expect(
      acceptInvite(ctx.db, { token: invite.token, managerId: j1.id }),
    ).rejects.toBeInstanceOf(LeagueError);
  });

  it("a revoked invite cannot be redeemed", async () => {
    const owner = await createManager(ctx.db, {
      firebaseUid: "owner5",
      displayName: "Owner5",
      email: "o5@example.com",
    });
    const { league } = await createLeague(ctx.db, {
      ownerManagerId: owner.id,
      name: "Revoked",
    });
    const joiner = await createManager(ctx.db, {
      firebaseUid: "j5",
      displayName: "J5",
      email: "j5@example.com",
    });
    const invite = await inviteManager(ctx.db, { leagueId: league.id });
    await revokeInvite(ctx.db, invite.id);
    await expect(
      acceptInvite(ctx.db, { token: invite.token, managerId: joiner.id }),
    ).rejects.toBeInstanceOf(LeagueError);
  });

  it("enforces max_managers", async () => {
    const owner = await createManager(ctx.db, {
      firebaseUid: "ownerM",
      displayName: "OwnerM",
      email: "om@example.com",
    });
    // maxManagers 2: owner + exactly one joiner.
    const { league } = await createLeague(ctx.db, {
      ownerManagerId: owner.id,
      name: "Tiny",
      maxManagers: 2,
    });
    const j1 = await createManager(ctx.db, {
      firebaseUid: "jm1",
      displayName: "JM1",
      email: "jm1@example.com",
    });
    const j2 = await createManager(ctx.db, {
      firebaseUid: "jm2",
      displayName: "JM2",
      email: "jm2@example.com",
    });
    const inv1 = await inviteManager(ctx.db, { leagueId: league.id });
    await acceptInvite(ctx.db, { token: inv1.token, managerId: j1.id });
    // League is now full (owner + j1 = 2).
    const inv2 = await inviteManager(ctx.db, { leagueId: league.id });
    await expect(
      acceptInvite(ctx.db, { token: inv2.token, managerId: j2.id }),
    ).rejects.toBeInstanceOf(LeagueError);
  });

  it("a targeted invite rejects the wrong email", async () => {
    const owner = await createManager(ctx.db, {
      firebaseUid: "ownerT",
      displayName: "OwnerT",
      email: "ot@example.com",
    });
    const { league } = await createLeague(ctx.db, {
      ownerManagerId: owner.id,
      name: "Targeted",
    });
    const joiner = await createManager(ctx.db, {
      firebaseUid: "jt",
      displayName: "JT",
      email: "real@example.com",
    });
    const invite = await inviteManager(ctx.db, {
      leagueId: league.id,
      email: "someone-else@example.com",
    });
    await expect(
      acceptInvite(ctx.db, { token: invite.token, managerId: joiner.id }),
    ).rejects.toBeInstanceOf(LeagueError);
  });

  it("addPlayerToRoster drafts a player and updates counts", async () => {
    await ingestSquads(ctx.db, new FixtureMockProvider({ root: FIXTURES }));
    const owner = await createManager(ctx.db, {
      firebaseUid: "ownerR",
      displayName: "OwnerR",
      email: "or@example.com",
    });
    const { ownerTeam } = await createLeague(ctx.db, {
      ownerManagerId: owner.id,
      name: "Roster League",
    });

    // Messi (source id 1003) is a FWD.
    const [messi] = await ctx.db
      .select()
      .from(player)
      .where(eq(player.sourcePlayerId, "1003"));
    if (!messi) throw new Error("messi not ingested");

    const result = await addPlayerToRoster(ctx.db, {
      fantasyTeamId: ownerTeam.id,
      playerId: messi.id,
    });
    expect(result.counts.FWD).toBe(1);
    expect(await getRosterCounts(ctx.db, ownerTeam.id)).toEqual({
      GK: 0,
      DEF: 0,
      MID: 0,
      FWD: 1,
    });
  });

  it("rejects drafting a player already taken in the same league", async () => {
    await ingestSquads(ctx.db, new FixtureMockProvider({ root: FIXTURES }));
    const owner = await createManager(ctx.db, {
      firebaseUid: "ownerD",
      displayName: "OwnerD",
      email: "od@example.com",
    });
    const { league, ownerTeam } = await createLeague(ctx.db, {
      ownerManagerId: owner.id,
      name: "Dup League",
    });
    const joiner = await createManager(ctx.db, {
      firebaseUid: "jd",
      displayName: "JD",
      email: "jd@example.com",
    });
    const invite = await inviteManager(ctx.db, { leagueId: league.id });
    const joined = await acceptInvite(ctx.db, {
      token: invite.token,
      managerId: joiner.id,
    });

    const [messi] = await ctx.db
      .select()
      .from(player)
      .where(eq(player.sourcePlayerId, "1003"));
    if (!messi) throw new Error("messi not ingested");

    await addPlayerToRoster(ctx.db, {
      fantasyTeamId: ownerTeam.id,
      playerId: messi.id,
    });
    // Same player, a different team in the SAME league -> rejected.
    await expect(
      addPlayerToRoster(ctx.db, {
        fantasyTeamId: joined.team.id,
        playerId: messi.id,
      }),
    ).rejects.toBeInstanceOf(RosterError);
  });

  it("rejects a draft that would make a legal roster impossible", async () => {
    // Build a synthetic squad rich enough to corner a roster: we draft
    // 8 DEF + 8 MID + 5 FWD = 21, then a 6th FWD would strand the GK
    // minimum. addPlayerToRoster must refuse that 22nd pick.
    await ingestSquads(ctx.db, new FixtureMockProvider({ root: FIXTURES }));
    const owner = await createManager(ctx.db, {
      firebaseUid: "ownerC",
      displayName: "OwnerC",
      email: "oc@example.com",
    });
    const { ownerTeam } = await createLeague(ctx.db, {
      ownerManagerId: owner.id,
      name: "Corner League",
    });

    // The mock squad set only has 12 players (3 per team) - not enough to
    // reach 21 picks. So we drive the validator directly via repeated
    // addPlayerToRoster against extra synthetic players inserted here.
    const { nationalTeam } = await import("../../src/data/db/schema.js");
    const [team] = await ctx.db.select().from(nationalTeam).limit(1);
    if (!team) throw new Error("no national team");
    const nationalTeamId = team.id;

    async function makePlayers(position: "GK" | "DEF" | "MID" | "FWD", n: number) {
      const ids: number[] = [];
      for (let i = 0; i < n; i += 1) {
        const [row] = await ctx.db
          .insert(player)
          .values({
            fullName: `Synthetic ${position} ${i}`,
            position,
            nationalTeamId,
            sourcePlayerId: `synthetic-${position}-${i}`,
          })
          .returning();
        if (row) ids.push(row.id);
      }
      return ids;
    }

    const defs = await makePlayers("DEF", 8);
    const mids = await makePlayers("MID", 8);
    const fwds = await makePlayers("FWD", 6);

    for (const id of defs) {
      await addPlayerToRoster(ctx.db, { fantasyTeamId: ownerTeam.id, playerId: id });
    }
    for (const id of mids) {
      await addPlayerToRoster(ctx.db, { fantasyTeamId: ownerTeam.id, playerId: id });
    }
    // 5 FWD are fine; total reaches 21.
    for (let i = 0; i < 5; i += 1) {
      await addPlayerToRoster(ctx.db, {
        fantasyTeamId: ownerTeam.id,
        playerId: fwds[i] as number,
      });
    }
    expect(await getRosterCounts(ctx.db, ownerTeam.id)).toEqual({
      GK: 0,
      DEF: 8,
      MID: 8,
      FWD: 5,
    });
    // The 6th FWD would leave 1 pick but GK needs 2 -> rejected.
    await expect(
      addPlayerToRoster(ctx.db, {
        fantasyTeamId: ownerTeam.id,
        playerId: fwds[5] as number,
      }),
    ).rejects.toBeInstanceOf(RosterError);
  });
});
