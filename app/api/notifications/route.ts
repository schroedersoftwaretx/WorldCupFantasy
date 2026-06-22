/**
 * GET /api/notifications
 *
 * The signed-in manager's in-app notification inbox (newest first) plus the
 * unread count for the nav bell. Thin adapter over the notify service.
 * Query: ?unread=1 to return only unread; ?limit=N to cap the list.
 */
import { z } from "zod";

import { listForManager, type ManagerInbox } from "@/data/notify/service";
import { handle } from "@/web/api";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { parseQuery } from "@/web/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Query: ?unread=1 (only unread) and ?limit=N (1-100, else 50). Both are
 * defaulting/clamping rather than rejecting, preserving the prior behaviour
 * where any out-of-range or non-numeric limit silently fell back to 50.
 */
const InboxQuerySchema = z.object({
  unread: z.string().optional().transform((v) => v === "1"),
  limit: z
    .string()
    .optional()
    .transform((v) => {
      const n = Number(v);
      return Number.isInteger(n) && n > 0 && n <= 100 ? n : 50;
    }),
});

export function GET(request: Request): Promise<Response> {
  return handle(async (): Promise<ManagerInbox> => {
    const { manager } = await requireUserForRoute(request);
    const { unread, limit } = parseQuery(
      new URL(request.url).searchParams,
      InboxQuerySchema,
    );
    return listForManager(getDb(), manager.id, { unreadOnly: unread, limit });
  });
}
