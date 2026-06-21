/**
 * Integration test for owner-driven custom scoring: setLeagueScoringRuleset
 * re-versions the ruleset and persists it onto the league, and refuses a write
 * to a non-existent league.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { league } from "../../src/data/db/schema.js";
import {
  createLeague,
  createManager,
  setLeagueScoringRuleset,
} from "../../src/data/league/service.js";
import { LeagueError } from "../../src/data/league/errors.js";
import {
  DEFAULT_RULESET,
  buildRuleset,
  sanitizeRulesetInput,
  type ScoringRuleset,
} from "../../src/data/scoring/ruleset.js";
import { setupContainer } from "./setup.js";

const { ctx } = setupContainer();

async function makeLeague() {
  const owner = await createManager(ctx.db, {
    firebaseUid: "owner",
    displayName: "Owner",
    email: "owner@example.com",
  });
  const { league: lg } = await createLeague(ctx.db, {
    ownerManagerId: owner.id,
    name: "Custom Scoring League",
  });
  return lg;
}

describe("league custom scoring (integration)", () => {
  beforeEach(async () => {
    await ctx.resetDb();
  });

  it("new leagues start on the canonical default ruleset", async () => {
    const lg = await makeLeague();
    expect((lg.scoringRuleset as ScoringRuleset).version).toBe(
      DEFAULT_RULESET.version,
    );
  });

  it("re-versions and persists custom values", async () => {
    const lg = await makeLeague();
    const values = sanitizeRulesetInput({ ...DEFAULT_RULESET, bigChanceCreated: 3 });

    const updated = await setLeagueScoringRuleset(ctx.db, lg.id, values);
    expect(updated.version).not.toBe(DEFAULT_RULESET.version);
    expect(updated.version).toBe(buildRuleset(values).version);
    expect(updated.bigChanceCreated).toBe(3);

    const [reloaded] = await ctx.db
      .select()
      .from(league)
      .where(eq(league.id, lg.id));
    const stored = reloaded!.scoringRuleset as ScoringRuleset;
    expect(stored.version).toBe(updated.version);
    expect(stored.bigChanceCreated).toBe(3);
  });

  it("rejects a write to a missing league", async () => {
    const values = sanitizeRulesetInput({ ...DEFAULT_RULESET });
    await expect(
      setLeagueScoringRuleset(ctx.db, 999999, values),
    ).rejects.toBeInstanceOf(LeagueError);
  });
});
