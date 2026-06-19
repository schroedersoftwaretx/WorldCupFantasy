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
import {
  getPreferences,
  isNotificationCategory,
  setPreference,
  type PreferenceMatrix,
} from "@/data/notify/preferences";
import { handle, HttpError } from "@/web/api";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handle(async (): Promise<{ preferences: PreferenceMatrix }> => {
    const { manager } = await requireUserForRoute(request);
    return { preferences: await getPreferences(getDb(), manager.id) };
  });
}

export function PUT(request: Request): Promise<Response> {
  return handle(async (): Promise<{ preferences: PreferenceMatrix }> => {
    const { manager } = await requireUserForRoute(request);
    const body = (await request.json()) as {
      category?: unknown;
      channel?: unknown;
      enabled?: unknown;
    };
    if (typeof body.category !== "string" || !isNotificationCategory(body.category)) {
      throw new HttpError("unknown notification category", "INVALID_PREF", 400);
    }
    if (body.channel !== "IN_APP" && body.channel !== "EMAIL") {
      throw new HttpError("channel must be IN_APP or EMAIL", "INVALID_PREF", 400);
    }
    if (typeof body.enabled !== "boolean") {
      throw new HttpError("enabled must be a boolean", "INVALID_PREF", 400);
    }
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
