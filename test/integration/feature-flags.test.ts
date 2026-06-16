/**
 * Integration tests for Phase 0 per-league feature flags
 * (src/data/league/feature-flags.ts).
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_FLAGS,
  FLAGS,
  getFlags,
  getFlagStates,
  isFlagEnabled,
  setFlag,
} from "../../src/data/league/feature-flags.js";
import { createLeague, createManager } from "../../src/data/league/service.js";
import { setupContainer } from "./setup.js";

const { ctx } = setupContainer();

let seq = 0;
async function freshLeague(): Promise<number> {
  seq += 1;
  const owner = await createManager(ctx.db, {
    firebaseUid: `ff-${seq}-${Math.random()}`,
    displayName: `Owner ${seq}`,
    email: `o${seq}@example.com`,
  });
  const { league } = await createLeague(ctx.db, {
    ownerManagerId: owner.id,
    name: `League ${seq}`,
  });
  return league.id;
}

describe("feature flags (integration)", () => {
  beforeEach(async () => {
    await ctx.resetDb();
  });

  it("getFlags returns typed defaults for a league with no rows", async () => {
    const id = await freshLeague();
    expect(await getFlags(ctx.db, id)).toEqual({ ...DEFAULT_FLAGS });
  });

  it("setFlag enables a flag and reads reflect it; upsert is idempotent", async () => {
    const id = await freshLeague();
    await setFlag(ctx.db, id, "chat", { enabled: true });
    expect((await getFlags(ctx.db, id)).chat).toBe(true);
    expect(await isFlagEnabled(ctx.db, id, "chat")).toBe(true);

    // Re-set the same value -> still a single row, still true.
    await setFlag(ctx.db, id, "chat", { enabled: true });
    expect((await getFlagStates(ctx.db, id)).chat.enabled).toBe(true);

    // Toggle off.
    await setFlag(ctx.db, id, "chat", { enabled: false });
    expect((await getFlags(ctx.db, id)).chat).toBe(false);
    expect(await isFlagEnabled(ctx.db, id, "chat")).toBe(false);
  });

  it("stores per-flag config", async () => {
    const id = await freshLeague();
    await setFlag(ctx.db, id, "chips", {
      enabled: true,
      config: { maxPerStage: 1 },
    });
    const states = await getFlagStates(ctx.db, id);
    expect(states.chips).toEqual({ enabled: true, config: { maxPerStage: 1 } });
  });

  it("FLAGS and DEFAULT_FLAGS are in sync", () => {
    expect(Object.keys(DEFAULT_FLAGS).sort()).toEqual([...FLAGS].sort());
    for (const f of FLAGS) expect(DEFAULT_FLAGS[f]).toBe(false);
  });
});
