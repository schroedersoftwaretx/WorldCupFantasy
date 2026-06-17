/**
 * Integration tests for the Phase 0 notification hub (src/data/notify).
 *
 * Exercises the real DB: one-call in-app + email enqueue, the bell unread
 * count, manager-scoped markRead, dedupe suppression, and email delivery via a
 * recording transport (including the FAILED -> retried path).
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  deliverPending,
  enqueue,
  listForManager,
  markRead,
} from "../../src/data/notify/service.js";
import { RecordingTransport } from "../../src/data/notify/transport.js";
import { createManager } from "../../src/data/league/service.js";
import { setupContainer } from "./setup.js";

const { ctx } = setupContainer();

let seq = 0;
async function freshManager() {
  seq += 1;
  return createManager(ctx.db, {
    firebaseUid: `notif-${seq}-${Math.random()}`,
    displayName: `Manager ${seq}`,
    email: `m${seq}@example.com`,
  });
}

describe("notification hub (integration)", () => {
  beforeEach(async () => {
    await ctx.resetDb();
  });

  it("enqueues an in-app + email notification in one call", async () => {
    const m = await freshManager();
    const rows = await enqueue(ctx.db, {
      managerId: m.id,
      type: "TEST",
      title: "Hi",
      body: "Body",
      channels: ["IN_APP", "EMAIL"],
    });
    expect(rows).toHaveLength(2);
    const inApp = rows.find((r) => r.channel === "IN_APP");
    const email = rows.find((r) => r.channel === "EMAIL");
    expect(inApp?.status).toBe("SENT");
    expect(email?.status).toBe("PENDING");
  });

  it("unread count reflects in-app rows and markRead clears one", async () => {
    const m = await freshManager();
    await enqueue(ctx.db, {
      managerId: m.id,
      type: "T",
      title: "A",
      body: "b",
      channels: ["IN_APP"],
    });
    await enqueue(ctx.db, {
      managerId: m.id,
      type: "T",
      title: "B",
      body: "b",
      channels: ["IN_APP"],
    });

    let inbox = await listForManager(ctx.db, m.id);
    expect(inbox.unreadCount).toBe(2);
    expect(inbox.notifications).toHaveLength(2);

    const ok = await markRead(ctx.db, m.id, inbox.notifications[0]!.id);
    expect(ok).toBe(true);

    inbox = await listForManager(ctx.db, m.id);
    expect(inbox.unreadCount).toBe(1);
  });

  it("markRead is scoped to the owning manager", async () => {
    const a = await freshManager();
    const b = await freshManager();
    const [row] = await enqueue(ctx.db, {
      managerId: a.id,
      type: "T",
      title: "x",
      body: "y",
      channels: ["IN_APP"],
    });
    expect(await markRead(ctx.db, b.id, row!.id)).toBe(false);
    expect(await markRead(ctx.db, a.id, row!.id)).toBe(true);
  });

  it("dedupe_key suppresses repeats per (manager, channel)", async () => {
    const m = await freshManager();
    const first = await enqueue(ctx.db, {
      managerId: m.id,
      type: "T",
      title: "x",
      body: "y",
      channels: ["IN_APP", "EMAIL"],
      dedupeKey: "k1",
    });
    expect(first).toHaveLength(2);

    const second = await enqueue(ctx.db, {
      managerId: m.id,
      type: "T",
      title: "x2",
      body: "y2",
      channels: ["IN_APP", "EMAIL"],
      dedupeKey: "k1",
    });
    expect(second).toHaveLength(0);

    const inbox = await listForManager(ctx.db, m.id);
    expect(inbox.notifications).toHaveLength(1);
  });

  it("deliverPending sends email rows via the transport, idempotently", async () => {
    const m = await freshManager();
    await enqueue(ctx.db, {
      managerId: m.id,
      type: "T",
      title: "Subject",
      body: "Body",
      channels: ["IN_APP", "EMAIL"],
    });

    const transport = new RecordingTransport();
    expect(await deliverPending(ctx.db, transport, { managerId: m.id })).toEqual({
      delivered: 1,
      failed: 0,
    });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.to).toBe(m.email);
    expect(transport.sent[0]!.subject).toBe("Subject");

    // Already SENT -> a second pass sends nothing.
    expect(await deliverPending(ctx.db, transport, { managerId: m.id })).toEqual({
      delivered: 0,
      failed: 0,
    });
  });

  it("a failed transport marks FAILED and is retried next time", async () => {
    const m = await freshManager();
    await enqueue(ctx.db, {
      managerId: m.id,
      type: "T",
      title: "s",
      body: "b",
      channels: ["EMAIL"],
    });

    const failing = new RecordingTransport(true);
    expect(await deliverPending(ctx.db, failing, { managerId: m.id })).toEqual({
      delivered: 0,
      failed: 1,
    });

    const working = new RecordingTransport();
    expect(await deliverPending(ctx.db, working, { managerId: m.id })).toEqual({
      delivered: 1,
      failed: 0,
    });
  });

  it("no transport is a safe no-op (rows stay durable)", async () => {
    const m = await freshManager();
    await enqueue(ctx.db, {
      managerId: m.id,
      type: "T",
      title: "s",
      body: "b",
      channels: ["EMAIL"],
    });
    expect(await deliverPending(ctx.db, undefined, { managerId: m.id })).toEqual({
      delivered: 0,
      failed: 0,
    });
  });
});
