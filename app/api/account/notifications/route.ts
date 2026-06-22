/**
 * GET /api/account/notifications  - the signed-in manager's notification
 *                                   preference matrix.
 * PUT /api/account/notifications  - toggle one (category, channel) for the
 *                                   signed-in manager. Body:
 *                                     { category, channel, enabled }
 *
 * Account-level (not league-scoped). Thin adapter over
 * `src/data/notify/preferences.ts`; returns the full matrix after a change so
 * the settings UI can re-render.
 */
import { z } from "zod";

import {
  getPreferences,
  NOTIFICATION_CATEGORIES,
  setPreference,
  type PreferenceMatrix,
} from "@/data/notify/preferences";
import { handle } from "@/web/api";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { parseBody } from "@/web/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PUT body: flip one (category, channel) preference. */
const PreferenceUpdateSchema = z.object({
  category: z.enum(NOTIFICATION_CATEGORIES),
  channel: z.enum(["IN_APP", "EMAIL"]),
  enabled: z.boolean(),
});

export function GET(request: Request): Promise<Response> {
  return handle(async (): Promise<{ preferences: PreferenceMatrix }> => {
    const { manager } = await requireUserForRoute(request);
    return { preferences: await getPreferences(getDb(), manager.id) };
  });
}

export function PUT(request: Request): Promise<Response> {
  return handle(async (): Promise<{ preferences: PreferenceMatrix }> => {
    const { manager } = await requireUserForRoute(request);
    const body = await parseBody(request, PreferenceUpdateSchema);
    const preferences = await setPreference(
      getDb(),
      manager.id,
      body.category,
      body.channel,
      body.enabled,
    );
    return { preferences };
  });
}
