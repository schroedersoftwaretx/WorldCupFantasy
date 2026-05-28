/**
 * Integration test for the recompute service.
 *
 * Runs the Phase 1 ingest chain into a real Postgres (Testcontainers or an
 * externally provided URL), then recomputes score_entry under the default
 * ruleset and asserts:
 *
 *   - one row per (player, fixture) for the players who played
 *   - point totals match what the unit tests / golden scenarios would yield
 *     for the same stat lines
 *   - recomputeAll is idempotent (rerun -> all skipped)
 *   - a tweaked ruleset produces a different ruleset_version, and that the
 *     two rulesets coexist on disk
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { fixture, player, scoreEntry } from "../../src/data/db/schema.js";
import { ingestFixtureStats } from "../../src/data/ingest/fixture-stats.js";
import { ingestSchedule } from "../../src/data/ingest/schedule.js";
import { ingestSquads } from "../../src/data/ingest/squads.js";
import { FixtureMockProvider } from "../../src/data/provider/mock.js";
import { recomputeAll, recomputeForFixture } from "../../src/data/scoring/recompute.js";
import { DEFAULT_RULESET, buildRuleset } from "../../src/data/scoring/ruleset.js";
import type { ScoreBreakdown } from "../../src/data/scoring/score.js";
import { setupContainer } from "./setup.js";

const FIXTURES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "provider",
);

const { ctx } = setupContainer();

describe("Phase 2 recompute (integration)", () => {
  beforeAll(async () => {
    await ctx.resetDb();
    const provider = new FixtureMockProvider({ root: FIXTURES });
    await ingestSquads(ctx.db, provider);
    await ingestSchedule(ctx.db, provider);
    await ingestFixtureStats(ctx.db, provider, "8001");
  });

  it("recomputeForFixture inserts one row per stat_line", async () => {
    const summary = await recomputeForFixture(ctx.db, DEFAULT_RULESET, "8001");
    expect(summary.inserted).toBe(6);
    expect(summary.updated).toBe(0);
    expect(summary.skipped).toBe(0);
  });

  it("re-running recomputeForFixture is a pure no-op", async () => {
    const summary = await recomputeForFixture(ctx.db, DEFAULT_RULESET, "8001");
    expect(summary.inserted).toBe(0);
    expect(summary.updated).toBe(0);
    expect(summary.skipped).toBe(6);
  });

  it("per-player point totals match the spec", async () => {
    const playerRows = await ctx.db.select().from(player);
    const fxRows = await ctx.db.select().from(fixture);
    const fx = fxRows.find((f) => f.sourceFixtureId === "8001");
    if (!fx) throw new Error("fixture 8001 not seeded");

    const rows = await ctx.db
      .select()
      .from(scoreEntry)
      .where(
        and(
          eq(scoreEntry.fixtureId, fx.id),
          eq(scoreEntry.rulesetVersion, DEFAULT_RULESET.version),
        ),
      );
    const pointsByPlayer = new Map<string, number>();
    for (const r of rows) {
      const p = playerRows.find((pl) => pl.id === r.playerId);
      if (!p) continue;
      pointsByPlayer.set(p.sourcePlayerId, r.points);
    }

    // Argentina (won 2-1, conceded 1):
    //   1001 Martinez (GK): 1 + 1 + 4 saves = 6
    //   1002 Romero  (DEF): 1 + 1 - 1 yellow = 1
    //   1003 Messi   (FWD): 1 + 1 + 2*4 = 10
    expect(pointsByPlayer.get("1001")).toBe(6);
    expect(pointsByPlayer.get("1002")).toBe(1);
    expect(pointsByPlayer.get("1003")).toBe(10);
    // Brazil (lost 1-2, conceded 2):
    //   2001 Alisson (GK):  1 + 1 + 3 saves = 5
    //   2002 Casemiro(MID): 1 + 1 + 1*5 = 7
    //   2003 Vini    (FWD): 1 + 1 + 1*4 assist = 6
    expect(pointsByPlayer.get("2001")).toBe(5);
    expect(pointsByPlayer.get("2002")).toBe(7);
    expect(pointsByPlayer.get("2003")).toBe(6);
  });

  it("breakdown decomposition matches the total", async () => {
    const rows = await ctx.db.select().from(scoreEntry);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const b = r.breakdown as ScoreBreakdown;
      const sum =
        b.appearance +
        b.played60Plus +
        b.goals +
        b.assists +
        b.saves +
        b.cleanSheet +
        b.penaltiesSaved +
        b.penaltiesMissed +
        b.ownGoals +
        b.yellowCards +
        b.redCards;
      expect(sum).toBe(r.points);
    }
  });

  it("recomputeAll over the same data is also idempotent", async () => {
    const summary = await recomputeAll(ctx.db, DEFAULT_RULESET);
    expect(summary.inserted).toBe(0);
    expect(summary.updated).toBe(0);
    expect(summary.skipped).toBe(6);
  });

  it("a tweaked ruleset coexists with the default (new ruleset_version)", async () => {
    const tweaked = buildRuleset({
      ...DEFAULT_RULESET,
      goalByPosition: { ...DEFAULT_RULESET.goalByPosition, FWD: 5 },
    });
    expect(tweaked.version).not.toBe(DEFAULT_RULESET.version);

    const summary = await recomputeAll(ctx.db, tweaked);
    expect(summary.inserted).toBe(6);

    const defaultRows = await ctx.db
      .select()
      .from(scoreEntry)
      .where(eq(scoreEntry.rulesetVersion, DEFAULT_RULESET.version));
    expect(defaultRows).toHaveLength(6);

    // Tweaked Messi: 1 + 1 + 2*5 = 12 (was 10 under default).
    const playerRows = await ctx.db.select().from(player);
    const messi = playerRows.find((p) => p.sourcePlayerId === "1003");
    if (!messi) throw new Error("messi not seeded");
    const tweakedRows = await ctx.db
      .select()
      .from(scoreEntry)
      .where(
        and(
          eq(scoreEntry.rulesetVersion, tweaked.version),
          eq(scoreEntry.playerId, messi.id),
        ),
      );
    expect(tweakedRows[0]?.points).toBe(12);
  });
});
