/**
 * GET /api/cron/draft-tick
 *
 * The scheduled draft tick. Autopicks every lapsed pick across all drafts.
 * Not user-facing - it is called by Vercel Cron (see vercel.json). When
 * CRON_SECRET is set, the caller must present it as a Bearer token; Vercel
 * sends it automatically. When unset, the route is open (local dev). The
 * operation is idempotent, so a stray call is harmless.
 */
import { processExpiredPicks } from "@/data/draft/service";
import { handle, HttpError } from "@/web/api";
import { getDb } from "@/web/db";
import { getNotifier } from "@/web/notifier";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const secret = process.env["CRON_SECRET"];
    if (secret) {
      if (request.headers.get("authorization") !== `Bearer ${secret}`) {
        throw new HttpError("unauthorized", "UNAUTHORIZED", 401);
      }
    }
    const notifier = getNotifier();
    return processExpiredPicks(getDb(), notifier ? { notifier } : {});
  });
}
