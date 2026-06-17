/**
 * GET /api/notifications
 *
 * The signed-in manager's in-app notification inbox (newest first) plus the
 * unread count for the nav bell. Thin adapter over the notify service.
 * Query: ?unread=1 to return only unread; ?limit=N to cap the list.
 */
import { listForManager, type ManagerInbox } from "@/data/notify/service";
import { handle } from "@/web/api";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handle(async (): Promise<ManagerInbox> => {
    const { manager } = await requireUserForRoute(request);
    const url = new URL(request.url);
    const unreadOnly = url.searchParams.get("unread") === "1";
    const limitRaw = Number(url.searchParams.get("limit"));
    const limit =
      Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 100
        ? limitRaw
        : 50;
    return listForManager(getDb(), manager.id, { unreadOnly, limit });
  });
}
