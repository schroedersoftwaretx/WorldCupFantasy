/**
 * End-to-end ingestion tests using Testcontainers Postgres.
 *
 * Covers the Phase 1 acceptance criteria:
 *   3. All three ingestion CLI commands run idempotently against
 *      FixtureMockProvider (run twice → identical state).
 *   4. The end-to-end test (squads + schedule + one finished fixture's stats)
 *      passes with no network access.
 *
 * Requires Docker to be available on the host. With no Docker, the container
 * boot in `setupContainer()` will throw and the suite will fail at startup
 * — that's the expected signal that the environment isn't provisioned.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { fixture, nationalTeam, player, statLine } from "../../src/data/db/schema.js";
import { ingestFixtureStats } from "../../src/data/ingest/fixture-stats.js";
import { ingestSchedule } from "../../src/data/ingest/schedule.js";
import { ingestSquads } from "../../src/data/ingest/squads.js";
import { FixtureMockProvider } from "../../src/data/provider/mock.js";
import { setupContainer } from "./setup.js";

const FIXTURES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "provider",
);

const { ctx } = setupContainer();

describe("Phase 1 ingestion (integration)", () => {
  beforeEach(async () => {
    await ctx.resetDb();
  });

  it("ingest:squads is idempotent — second run produces identical state", async () => {
    const provider = new FixtureMockProvider({ root: FIXTURES });

    const first = await ingestSquads(ctx.db, provider);
    expect(first.teams.inserted).toBe(4);
    expect(first.teams.updated).toBe(0);
    expect(first.teams.skipped).toBe(0);
    expect(first.players.inserted).toBe(12);
    expect(first.players.updated).toBe(0);
    expect(first.players.skipped).toBe(0);

    // Snapshot row contents after the first run.
    const teamsAfter1 = await ctx.db.select().from(nationalTeam).orderBy(nationalTeam.id);
    const playersAfter1 = await ctx.db.select().from(player).orderBy(player.id);
    expect(teamsAfter1).toHaveLength(4);
    expect(playersAfter1).toHaveLength(12);

    // Second run: same data → all skipped, nothing inserted or updated.
    const second = await ingestSquads(ctx.db, provider);
    expect(second.teams.inserted).toBe(0);
    expect(second.teams.updated).toBe(0);
    expect(second.teams.skipped).toBe(4);
    expect(second.players.inserted).toBe(0);
    expect(second.players.updated).toBe(0);
    expect(second.players.skipped).toBe(12);

    const teamsAfter2 = await ctx.db.select().from(nationalTeam).orderBy(nationalTeam.id);
    const playersAfter2 = await ctx.db.select().from(player).orderBy(player.id);
    // Same set of ids — no rows added or replaced.
    expect(teamsAfter2.map((r) => r.id)).toEqual(teamsAfter1.map((r) => r.id));
    expect(playersAfter2.map((r) => r.id)).toEqual(playersAfter1.map((r) => r.id));
  });

  it("ingest:schedule skips fixtures with unresolved teams, then is idempotent", async () => {
    const provider = new FixtureMockProvider({ root: FIXTURES });

    // Without squads every fixture has unresolved teams: skip them all (don't
    // abort) so a single TBD knockout slot can't block the whole ingest.
    const beforeSquads = await ingestSchedule(ctx.db, provider);
    expect(beforeSquads.inserted).toBe(0);
    expect(beforeSquads.updated).toBe(0);
    expect(beforeSquads.skipped).toBe(6);
    expect(await ctx.db.select().from(fixture)).toHaveLength(0);

    await ingestSquads(ctx.db, provider);
    const first = await ingestSchedule(ctx.db, provider);
    expect(first.inserted).toBe(6);
    expect(first.updated).toBe(0);
    expect(first.skipped).toBe(0);

    const second = await ingestSchedule(ctx.db, provider);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.skipped).toBe(6);

    const rows = await ctx.db.select().from(fixture).orderBy(fixture.id);
    expect(rows).toHaveLength(6);
    const finished = rows.find((r) => r.sourceFixtureId === "8001")!;
    expect(finished.status).toBe("FINISHED");
    expect(finished.homeScore).toBe(2);
    expect(finished.awayScore).toBe(1);
    expect(finished.stage).toBe("GROUP_1");
  });

  it("ingest:fixture-stats is idempotent and links to the right players + fixture", async () => {
    const provider = new FixtureMockProvider({ root: FIXTURES });

    await ingestSquads(ctx.db, provider);
    await ingestSchedule(ctx.db, provider);

    const first = await ingestFixtureStats(ctx.db, provider, "8001");
    expect(first.inserted).toBe(6);
    expect(first.updated).toBe(0);
    expect(first.skipped).toBe(0);

    const second = await ingestFixtureStats(ctx.db, provider, "8001");
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    // Same revision tag on both runs → all 6 lines are skipped.
    expect(second.skipped).toBe(6);

    // Verify content is what mapFixtureStats produced. We index via the
    // join because tests should never assume internal id ordering.
    const rows = await ctx.db.select().from(statLine);
    expect(rows).toHaveLength(6);

    const playerRows = await ctx.db.select().from(player);
    const playerSourceById = new Map(playerRows.map((p) => [p.id, p.sourcePlayerId]));

    const fxRows = await ctx.db.select().from(fixture);
    const targetFx = fxRows.find((f) => f.sourceFixtureId === "8001")!;
    for (const row of rows) {
      expect(row.fixtureId).toBe(targetFx.id);
    }

    const byPlayerSource = new Map(
      rows.map((r) => [playerSourceById.get(r.playerId)!, r]),
    );

    expect(byPlayerSource.get("1003")?.goals).toBe(2); // Messi
    expect(byPlayerSource.get("1003")?.minutesPlayed).toBe(90);
    expect(byPlayerSource.get("1003")?.teamConcededInRegulationAndEt).toBe(1);

    expect(byPlayerSource.get("2002")?.goals).toBe(1); // Casemiro
    expect(byPlayerSource.get("2002")?.minutesPlayed).toBe(75);
    expect(byPlayerSource.get("2002")?.teamConcededInRegulationAndEt).toBe(2);

    expect(byPlayerSource.get("1001")?.saves).toBe(4); // Martínez
    expect(byPlayerSource.get("1002")?.yellowCards).toBe(1); // Romero
    expect(byPlayerSource.get("2003")?.assists).toBe(1); // Vinícius
  });

  it("full chain end-to-end: squads + schedule + one finished fixture's stats", async () => {
    const provider = new FixtureMockProvider({ root: FIXTURES });

    await ingestSquads(ctx.db, provider);
    await ingestSchedule(ctx.db, provider);
    const stats = await ingestFixtureStats(ctx.db, provider, "8001");

    // Acceptance criterion: stat_line rows produced, linked correctly.
    expect(stats.inserted).toBe(6);

    const teams = await ctx.db.select().from(nationalTeam);
    const players = await ctx.db.select().from(player);
    const fixtures = await ctx.db.select().from(fixture);
    const lines = await ctx.db.select().from(statLine);

    expect(teams).toHaveLength(4);
    expect(players).toHaveLength(12);
    expect(fixtures).toHaveLength(6);
    expect(lines).toHaveLength(6);

    // The 6 stat-lines all belong to the single finished fixture, and to
    // the 6 players (3 from Argentina, 3 from Brazil) who played in it.
    const finishedFx = fixtures.find((f) => f.sourceFixtureId === "8001")!;
    expect(lines.every((l) => l.fixtureId === finishedFx.id)).toBe(true);

    const playerById = new Map(players.map((p) => [p.id, p]));
    const teamIds = new Set(lines.map((l) => playerById.get(l.playerId)!.nationalTeamId));
    expect(teamIds.size).toBe(2);
  });
});
