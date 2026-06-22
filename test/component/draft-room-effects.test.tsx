// @vitest-environment jsdom
/**
 * DraftRoom — the SSE fallback and the on-clock side effects.
 *
 *   - Polling fallback: when EventSource is unavailable the component polls
 *     GET /api/leagues/{id}/draft on a POLL_MS interval and re-renders on the
 *     fresh state (driven here with fake timers).
 *   - On-clock: when the viewer goes on the clock it flips document.title and,
 *     if notifications are granted, fires a browser Notification; the title
 *     resets once they are no longer on the clock.
 *
 * Both fetch and EventSource/Notification are mocked; nothing hits the network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

import "./setup";

import type { DraftStateData } from "../../src/web/api-types";
import { DEFAULT_RULESET } from "../../src/data/scoring/ruleset";
import DraftRoom from "../../app/leagues/[leagueId]/draft/draft-room";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>{children}</a>
  ),
}));

const POLL_MS = 5000;

function inProgress(pickNumber: number, isOnClock: boolean): DraftStateData {
  return {
    status: "IN_PROGRESS",
    draftRoomId: 1,
    pickTimerHours: 12,
    rosterSize: 23,
    teamCount: 2,
    totalPicks: 46,
    picksMade: pickNumber - 1,
    currentPickNumber: pickNumber,
    currentRound: 1,
    currentPickDeadline: new Date(Date.now() + 600_000).toISOString(),
    onClockTeamId: 101,
    order: [
      { slot: 1, fantasyTeamId: 100, teamName: "Team A", managerName: "Alice" },
      { slot: 2, fantasyTeamId: 101, teamName: "Team B", managerName: "Bob" },
    ],
    picks: [],
    viewer: {
      managerId: 1, fantasyTeamId: 101, teamName: "Team B",
      isOwner: false, isOnClock,
      roster: [], counts: { GK: 0, DEF: 0, MID: 0, FWD: 0 },
    },
    emailNotifications: true,
  };
}

function resp(data: unknown) {
  return { ok: true, json: async () => ({ data }) } as unknown as Response;
}

// --- controllable EventSource (for the on-clock test) ----------------------
class MockEventSource {
  static instances: MockEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  url: string;
  readyState = MockEventSource.OPEN;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(url: string) { this.url = url; MockEventSource.instances.push(this); }
  close() { this.readyState = MockEventSource.CLOSED; }
  push(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
}

describe("DraftRoom polling fallback (no EventSource)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("polls GET /draft and re-renders as state changes", async () => {
    let current = inProgress(1, false);
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith("/draft/board")) return resp({ players: [] });
      if (u.endsWith("/draft/queue")) return resp({ queue: [] });
      return resp(current);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<DraftRoom leagueId={1} ruleset={DEFAULT_RULESET} />);
    // Flush the immediate poll fired on mount.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(screen.getByText(/Pick #1\b/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/leagues/1/draft",
      expect.objectContaining({ cache: "no-store" }),
    );

    // Advance one interval; the next poll returns a newer state.
    current = inProgress(2, false);
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });
    expect(screen.getByText(/Pick #2\b/)).toBeInTheDocument();
  });
});

describe("DraftRoom on-clock effects", () => {
  let notifCalls: { title: string; opts: unknown }[];
  function MockNotification(this: unknown, title: string, opts: unknown) {
    notifCalls.push({ title, opts });
  }
  (MockNotification as any).permission = "granted";
  (MockNotification as any).requestPermission = vi.fn(async () => "granted");

  beforeEach(() => {
    notifCalls = [];
    document.title = "Base Title";
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
    vi.stubGlobal("Notification", MockNotification);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith("/draft/board")) return resp({ players: [] });
      if (u.endsWith("/draft/queue")) return resp({ queue: [] });
      return resp(inProgress(1, true));
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("flips the tab title and fires a Notification when the viewer is on the clock", async () => {
    render(<DraftRoom leagueId={1} ruleset={DEFAULT_RULESET} />);
    const es = MockEventSource.instances[0]!;

    await act(async () => { es.push(inProgress(1, true)); });

    expect(document.title).toBe("⏰ Your pick! — Draft Room");
    expect(notifCalls).toHaveLength(1);
    expect(notifCalls[0]!.title).toBe("You're on the clock!");

    // Once no longer on the clock the title resets and no new Notification fires.
    await act(async () => { es.push(inProgress(2, false)); });
    expect(document.title).toBe("Base Title");
    expect(notifCalls).toHaveLength(1);
  });
});
