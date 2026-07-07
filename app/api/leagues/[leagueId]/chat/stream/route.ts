/**
 * GET /api/leagues/[leagueId]/chat/stream
 *
 * SSE stream of the latest chat page (newest-first, 50 messages with
 * reactions), via the Phase 0 poll+diff helper. Emits on connect, then only
 * when the serialized page changes. Auth/membership/flag checked up front
 * so failures return the usual JSON error envelope.
 */
import { ChatError, listMessages } from "@/data/social/chat";
import { err, HttpError, parseId } from "@/web/api";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { streamSnapshots } from "@/web/realtime/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Chat cadence per the phase-03 doc. */
const POLL_MS = 2500;

export async function GET(
  request: Request,
  ctx: { params: Promise<{ leagueId: string }> },
): Promise<Response> {
  let leagueIdNum: number;
  let managerId: number;
  try {
    const { manager } = await requireUserForRoute(request);
    const { leagueId } = await ctx.params;
    leagueIdNum = parseId(leagueId, "leagueId");
    managerId = manager.id;
    // Probe once so a non-member / flag-off league fails fast as JSON.
    await listMessages(getDb(), { leagueId: leagueIdNum, managerId, limit: 1 });
  } catch (e) {
    if (e instanceof HttpError) return err(e.message, e.code, e.status);
    if (e instanceof ChatError) return err(e.message, e.code, 400);
    return err("could not open the chat stream", "INTERNAL", 500);
  }

  const db = getDb();
  return streamSnapshots({
    getSnapshot: () =>
      listMessages(db, { leagueId: leagueIdNum, managerId, limit: 50 }),
    pollMs: POLL_MS,
    signal: request.signal,
  });
}
