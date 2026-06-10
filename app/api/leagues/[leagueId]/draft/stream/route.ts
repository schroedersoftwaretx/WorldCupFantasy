/**
 * GET /api/leagues/[leagueId]/draft/stream
 *
 * A Server-Sent Events stream of the draft-room state. It emits the current
 * state immediately on connect, then re-emits whenever the state changes
 * (detected by polling the DB internally every couple of seconds and diffing
 * the serialized payload). This replaces the client's 5s poll: managers see a
 * pick land within ~1-2s instead of waiting for the next poll tick.
 *
 * Unlike the JSON routes this does not use `handle` - it returns a raw
 * `text/event-stream` Response. Each event's `data:` is the bare
 * DraftStateData object (no envelope), so the client can `JSON.parse` and
 * `setState` directly. Errors before the stream opens still return the usual
 * JSON error envelope.
 */
import { err, HttpError, parseId } from "@/web/api";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { getDraftRoomView } from "@/web/draft-view";
import { getMembershipRole } from "@/web/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How often to re-check the DB for a state change. */
const POLL_MS = 1500;
/** Heartbeat comment interval, to keep intermediaries from closing the pipe. */
const HEARTBEAT_MS = 25_000;

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

  const encoder = new TextEncoder();
  let lastPayload = "";
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let beatTimer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const db = getDb();

      const sendIfChanged = async (): Promise<void> => {
        try {
          const state = await getDraftRoomView(db, leagueIdNum, managerId);
          const payload = JSON.stringify(state);
          if (payload !== lastPayload) {
            lastPayload = payload;
            controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
          }
        } catch {
          // Transient DB hiccup: keep the stream open and try again next tick.
          // The client's own error/reconnect path covers a hard failure.
        }
      };

      // Emit the current state immediately, then poll for changes.
      await sendIfChanged();
      pollTimer = setInterval(() => void sendIfChanged(), POLL_MS);
      beatTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          /* controller already closed */
        }
      }, HEARTBEAT_MS);
    },
    cancel() {
      if (pollTimer) clearInterval(pollTimer);
      if (beatTimer) clearInterval(beatTimer);
    },
  });

  // Tear down timers when the client disconnects.
  request.signal.addEventListener("abort", () => {
    if (pollTimer) clearInterval(pollTimer);
    if (beatTimer) clearInterval(beatTimer);
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
