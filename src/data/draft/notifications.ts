/**
 * Async snake-draft state machine - best-effort notification delivery.
 *
 * The in-transaction emitters that WRITE the PENDING rows live in
 * `./internals.ts` (they are tightly coupled to the pick state machine).
 * This module owns the after-the-fact DELIVERY: draining PENDING/FAILED
 * `draft_notification` rows through a `Notifier`, honouring the manager's
 * channel preferences and marking each row SENT or FAILED.
 */

import { and, eq, inArray } from "drizzle-orm";

import type { Db } from "../db/client.js";
import {
  draftNotification,
  draftRoom,
  fantasyTeam,
  manager,
} from "../db/schema.js";
import { allowedChannels } from "../notify/preferences.js";
import type { Notifier } from "./notifier.js";

/**
 * Deliver every not-yet-SENT notification (PENDING or a prior FAILED) via
 * the notifier. A no-op when no notifier is supplied - the rows stay
 * durable and a later call delivers them.
 */
export async function deliverPending(
  db: Db,
  notifier: Notifier | undefined,
  draftRoomId?: number,
): Promise<{ delivered: number; failed: number }> {
  if (!notifier) return { delivered: 0, failed: 0 };

  const pending = await db
    .select()
    .from(draftNotification)
    .where(
      draftRoomId !== undefined
        ? and(
            eq(draftNotification.draftRoomId, draftRoomId),
            inArray(draftNotification.status, ["PENDING", "FAILED"]),
          )
        : inArray(draftNotification.status, ["PENDING", "FAILED"]),
    );

  let delivered = 0;
  let failed = 0;
  for (const n of pending) {
    const [mgr] = await db.select().from(manager).where(eq(manager.id, n.managerId));
    if (!mgr) continue;

    // Phase 8 interim: the draft still delivers over this legacy email path
    // (not the Phase 0 hub), so honour the manager's notification preferences
    // here. If they have opted out of EMAIL for this category, mark the row
    // handled so it is not retried each tick, and skip the send.
    const channels = await allowedChannels(db, n.managerId, n.type, ["EMAIL"]);
    if (!channels.includes("EMAIL")) {
      await db
        .update(draftNotification)
        .set({ status: "SENT", sentAt: new Date() })
        .where(eq(draftNotification.id, n.id));
      continue;
    }

    // Enrich with the league id and team name so a rich notifier can build a
    // direct draft-room link. Cheap lookups; the set of pending rows is small.
    const [room] = await db
      .select({ leagueId: draftRoom.leagueId })
      .from(draftRoom)
      .where(eq(draftRoom.id, n.draftRoomId));
    let teamName: string | null = null;
    if (n.fantasyTeamId !== null) {
      const [t] = await db
        .select({ name: fantasyTeam.name })
        .from(fantasyTeam)
        .where(eq(fantasyTeam.id, n.fantasyTeamId));
      teamName = t?.name ?? null;
    }

    const result = await notifier.send({
      to: mgr.email,
      toName: mgr.displayName,
      type: n.type,
      subject: n.subject,
      body: n.body,
      ...(room ? { leagueId: room.leagueId } : {}),
      teamName,
    });
    if (result.delivered) {
      await db
        .update(draftNotification)
        .set({ status: "SENT", sentAt: new Date() })
        .where(eq(draftNotification.id, n.id));
      delivered += 1;
    } else {
      await db
        .update(draftNotification)
        .set({ status: "FAILED" })
        .where(eq(draftNotification.id, n.id));
      failed += 1;
    }
  }
  return { delivered, failed };
}
