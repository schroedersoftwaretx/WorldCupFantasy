/**
 * League activity feed (phase-03 3.2) - append-only derived events.
 *
 * New features WRITE events here (chips played, H2H schedule generated,
 * auto stage recaps); things already logged elsewhere (draft picks) can be
 * projected on read later rather than duplicated. Reads are member-gated at
 * the route; writes are called by trusted services.
 *
 * Pure service: takes a Db and plain inputs; no HTTP/auth/env here.
 */
import { desc, eq } from "drizzle-orm";

import type { Db, DbTx } from "../db/client.js";
import { activityEvent, type ActivityEventRow } from "../db/schema.js";

export const ACTIVITY_TYPES = [
  "CHIP_PLAYED",
  "H2H_SCHEDULE_GENERATED",
  "STAGE_RECAP",
  "SURVIVOR_ELIMINATED",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/** Append one event. Failures are the caller's to decide on (most producers
 * treat the feed as best-effort and swallow). */
export async function recordEvent(
  db: Db | DbTx,
  leagueId: number,
  type: ActivityType,
  payload: unknown,
): Promise<ActivityEventRow | null> {
  const [row] = await db
    .insert(activityEvent)
    .values({ leagueId, type, payload })
    .returning();
  return row ?? null;
}

/** Latest events for a league, newest first (max 100). */
export async function listActivity(
  db: Db,
  leagueId: number,
  limit = 50,
): Promise<ActivityEventRow[]> {
  return db
    .select()
    .from(activityEvent)
    .where(eq(activityEvent.leagueId, leagueId))
    .orderBy(desc(activityEvent.id))
    .limit(Math.min(Math.max(limit, 1), 100));
}
