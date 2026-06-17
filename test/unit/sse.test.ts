/**
 * Unit tests for the shared SSE helper (src/web/realtime/sse.ts).
 *
 * No DB: a snapshot getter over a mutable value drives the stream. We read the
 * raw event-stream body and assert the initial emit, change-only re-emits, and
 * the heartbeat comment.
 */
import { describe, expect, it } from "vitest";

import { streamSnapshots } from "../../src/web/realtime/sse.js";

describe("streamSnapshots (SSE helper)", () => {
  it("emits initial snapshot, re-emits on change, and heartbeats", async () => {
    let value: { n: number } = { n: 1 };
    const ac = new AbortController();
    const res = streamSnapshots({
      getSnapshot: async () => value,
      pollMs: 10,
      signal: ac.signal,
      heartbeatMs: 20,
    });
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const data: string[] = [];
    let sawHeartbeat = false;
    let changed = false;
    const start = Date.now();
    while (Date.now() - start < 500) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (frame.startsWith("data: ")) data.push(frame.slice("data: ".length));
        else if (frame.startsWith(":")) sawHeartbeat = true;
      }
      if (!changed && data.length >= 1) {
        value = { n: 2 };
        changed = true;
      }
      if (data.includes('{"n":2}') && sawHeartbeat) break;
    }
    ac.abort();
    void reader.cancel().catch(() => {});

    expect(data[0]).toBe('{"n":1}');
    expect(data).toContain('{"n":2}');
    expect(sawHeartbeat).toBe(true);
  });

  it("does not re-emit when the snapshot is unchanged", async () => {
    const ac = new AbortController();
    const res = streamSnapshots({
      getSnapshot: async () => ({ n: 1 }),
      pollMs: 10,
      signal: ac.signal,
      heartbeatMs: 1_000,
    });

    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const data: string[] = [];
    const start = Date.now();
    while (Date.now() - start < 150) {
      const raced = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: boolean }>((r) =>
          setTimeout(() => r({ value: undefined, done: false }), 40),
        ),
      ]);
      if (raced.done) break;
      if (raced.value) {
        buf += dec.decode(raced.value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (frame.startsWith("data: ")) data.push(frame.slice(6));
        }
      }
    }
    ac.abort();
    void reader.cancel().catch(() => {});

    expect(data).toHaveLength(1); // only the initial emit
  });
});
