/**
 * POST /api/notifications/[id]/read
 *
 * Mark one of the signed-in manager's in-app notifications as read. Scoped to
 * the manager by the service, so a 404 is returned for someone else's row.
 */
import { markRead } from "@/data/notify/service";
import { handle, HttpError, parseId } from "@/web/api";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async (): Promise<{ read: boolean }> => {
    const { manager } = await requireUserForRoute(request);
    const { id } = await ctx.params;
    const notificationId = parseId(id, "notificationId");
    const ok = await markRead(getDb(), manager.id, notificationId);
    if (!ok) {
      throw new HttpError("notification not found", "NOTIFICATION_NOT_FOUND", 404);
    }
    return { read: true };
  });
}
