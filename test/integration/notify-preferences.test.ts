/**
 * Integration tests for per-manager notification preferences (Phase 8).
 *
 * Exercises the real DB: default opt-out matrix, setPreference upsert, and the
 * load-bearing requirement that `enqueue` SUPPRESSES an opted-out category's
 * channel (no row written), while leaving other categories and unmanaged types
 * untouched.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { enqueue, listForManager } from "../../src/data/notify/service.js";
import {
  getPreferences,
  setPreference,
} from "../../src/data/notify/preferences.js";
import { createManager } from "../../src/data/league/service.js";
import { setupContainer } from "./setup.js";

const { ctx } = setupContainer();

let seq = 0;
async function freshManager() {
  seq += 1;
  return createManager(ctx.db, {
    firebaseUid: `pref-${seq}-${Math.random()}`,
    displayName: `Manager ${seq}`,
    email: `pref${seq}@example.com`,
  });
}

describe("notification preferences (integration)", () => {
  beforeEach(async () => {
    await ctx.resetDb();
  });

  it("defaults every category/channel to enabled when nothing is stored", async () => {
    const m = await freshManager();
    const matrix = await getPreferences(ctx.db, m.id);
    expect(matrix.ON_THE_CLOCK.IN_APP).toBe(true);
    expect(matrix.ON_THE_CLOCK.EMAIL).toBe(true);
    expect(matrix.DRAFT_COMPLETE.EMAIL).toBe(true);
  });

  it("setPreference upserts and is idempotent", async () => {
    const m = await freshManager();
    let matrix = await setPreference(ctx.db, m.id, "ON_THE_CLOCK", "EMAIL", false);
    expect(matrix.ON_THE_CLOCK.EMAIL).toBe(false);
    // Re-set the same value: still false, no error.
    matrix = await setPreference(ctx.db, m.id, "ON_THE_CLOCK", "EMAIL", false);
    expect(matrix.ON_THE_CLOCK.EMAIL).toBe(false);
    // Flip back on.
    matrix = await setPreference(ctx.db, m.id, "ON_THE_CLOCK", "EMAIL", true);
    expect(matrix.ON_THE_CLOCK.EMAIL).toBe(true);
  });

  it("enqueue suppresses an opted-out category channel", async () => {
    const m = await freshManager();
    await setPreference(ctx.db, m.id, "ON_THE_CLOCK", "EMAIL", false);

    const rows = await enqueue(ctx.db, {
      managerId: m.id,
      type: "ON_THE_CLOCK",
      title: "You're up",
      body: "Pick now",
      channels: ["IN_APP", "EMAIL"],
    });
    // EMAIL dropped; only the IN_APP row is written.
    expect(rows.map((r) => r.channel)).toEqual(["IN_APP"]);
  });

  it("a fully opted-out category produces no notification at all", async () => {
    const m = await freshManager();
    await setPreference(ctx.db, m.id, "PICK_MADE", "IN_APP", false);
    await setPreference(ctx.db, m.id, "PICK_MADE", "EMAIL", false);

    const rows = await enqueue(ctx.db, {
      managerId: m.id,
      type: "PICK_MADE",
      title: "A pick",
      body: "happened",
      channels: ["IN_APP", "EMAIL"],
    });
    expect(rows).toHaveLength(0);
    const inbox = await listForManager(ctx.db, m.id);
    expect(inbox.notifications).toHaveLength(0);
  });

  it("opting out of one category leaves others delivering", async () => {
    const m = await freshManager();
    await setPreference(ctx.db, m.id, "ON_THE_CLOCK", "IN_APP", false);

    const rows = await enqueue(ctx.db, {
      managerId: m.id,
      type: "DRAFT_STARTED",
      title: "Draft started",
      body: "go",
      channels: ["IN_APP", "EMAIL"],
    });
    expect(rows.map((r) => r.channel).sort()).toEqual(["EMAIL", "IN_APP"]);
  });

  it("unmanaged types ignore preferences entirely", async () => {
    const m = await freshManager();
    // Even if a manager somehow had a row for an unmanaged category, an
    // unmanaged type still delivers (defensive: future kinds are not blocked).
    const rows = await enqueue(ctx.db, {
      managerId: m.id,
      type: "SOME_FUTURE_KIND",
      title: "x",
      body: "y",
      channels: ["IN_APP", "EMAIL"],
    });
    expect(rows).toHaveLength(2);
  });
});
