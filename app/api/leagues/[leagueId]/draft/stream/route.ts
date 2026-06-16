/**
 * GET /api/leagues/[leagueId]/draft/stream
 *
 * A Server-Sent Events stream of the draft-room state. It emits the current
 * state immediately on connect, then re-emits whenever the state changes
 * (detected by polling the DB internally and diffing the serialized payload).
 * This replaces the client's poll: managers see a pick land within ~1-2s.
 *
 * The poll+diff loop now lives in the shared `streamSnapshots` helper
 * (src/web/realtime/sse.ts); this route is a thin adapter that does auth +
 * membership up front (so failures return the usual JSON error envelope) and
 * hands the helper a snapshot getter. Each event's `data:` is the bare
 * DraftStateData object so the client can `JSON.parse` and `setState` directly.
 */
import { err, HttpError, parseId } from "@/web/api";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { getDraftRoomView } from "@/web/draft-view";
import { getMembershipRole } from "@/web/queries";
import { streamSnapshots } from "@/web/realtime/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How often to re-check the DB for a state change. */
const POLL_MS = 1500;

export async function GET(
  request: Request,
  ctx: { params: Promise<{ leagueId: string }> },
): Promise<Response> {
  // Auth + membership happen up front so failures return a normal JSON error.
  let leagueIdNum: number;
  let managerId: number;
  try {
    const { manager } = await requireUserForRoute(request);
    const { leagueId } = await ctx.params;
    leagueIdNum = parseId(leagueId, "leagueId");
    managerId = manager.id;
    const role = await getMembershipRole(getDb(), leagueIdNum, managerId);
    if (!role) {
      throw new HttpError(
        `league ${leagueIdNum} not found`,
        "LEAGUE_NOT_FOUND",
        404,
      );
    }
  } catch (e) {
    const he =
      e instanceof HttpError
        ? e
        : new HttpError("could not open the draft stream", "INTERNAL", 500);
    return err(he.message, he.code, he.status);
  }

  const db = getDb();
  return streamSnapshots({
    getSnapshot: () => getDraftRoomView(db, leagueIdNum, managerId),
    pollMs: POLL_MS,
    signal: request.signal,
  });
}
