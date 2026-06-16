/**
 * Reusable Server-Sent Events helper (Phase 0).
 *
 * Extracts the poll+diff loop the draft stream route pioneered so any surface
 * can stream a serialized snapshot: it emits the current snapshot on connect,
 * then re-emits ONLY when the serialized form changes (detected by an internal
 * source poll), plus a heartbeat comment so intermediaries do not close the
 * pipe. A transient error from getSnapshot is swallowed so one bad tick does
 * not tear down the stream; the client's own reconnect path covers a hard
 * failure.
 *
 * This is the SSE-poll pattern PLAN.md mandates (no websocket server). Pick a
 * pollMs that matches the surface (draft 1.5s, chat 2-3s, live stats 15-30s).
 */

export interface StreamSnapshotsOptions<T> {
  /** Load the current snapshot. Called once on connect, then every pollMs. */
  getSnapshot: () => Promise<T>;
  /** How often to re-check the source for a change, in ms. */
  pollMs: number;
  /** Request abort signal; tears down timers on client disconnect. */
  signal: AbortSignal;
  /** Heartbeat comment interval in ms. Default 25000. */
  heartbeatMs?: number;
  /** Serialize a snapshot for the wire and change detection. Default JSON. */
  serialize?: (snapshot: T) => string;
}

const DEFAULT_HEARTBEAT_MS = 25_000;

/**
 * Build a `text/event-stream` Response that streams snapshots. Each event's
 * `data:` is the serialized snapshot (no envelope), so an EventSource client
 * can JSON.parse it directly. Behavior matches the original draft stream loop.
 */
export function streamSnapshots<T>(options: StreamSnapshotsOptions<T>): Response {
  const {
    getSnapshot,
    pollMs,
    signal,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    serialize = (s: T) => JSON.stringify(s),
  } = options;

  const encoder = new TextEncoder();
  let lastPayload = "";
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let beatTimer: ReturnType<typeof setInterval> | undefined;

  const teardown = (): void => {
    if (pollTimer) clearInterval(pollTimer);
    if (beatTimer) clearInterval(beatTimer);
    pollTimer = undefined;
    beatTimer = undefined;
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sendIfChanged = async (): Promise<void> => {
        try {
          const payload = serialize(await getSnapshot());
          if (payload !== lastPayload) {
            lastPayload = payload;
            controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
          }
        } catch {
          // Transient source hiccup: keep the stream open, retry next tick.
        }
      };

      // Emit the current snapshot immediately, then poll for changes.
      await sendIfChanged();
      pollTimer = setInterval(() => void sendIfChanged(), pollMs);
      beatTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          /* controller already closed */
        }
      }, heartbeatMs);
    },
    cancel() {
      teardown();
    },
  });

  // Tear down timers when the client disconnects.
  signal.addEventListener("abort", teardown);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
