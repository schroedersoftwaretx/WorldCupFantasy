// @vitest-environment jsdom
/**
 * DraftRoom — the pre-draft lifecycle screens.
 *
 *   - status NONE: the owner sees the "set up the draft" form; creating it
 *     POSTs /api/leagues/{id}/draft and the UI advances to the start screen.
 *   - status PENDING: the owner sees the "start the draft" panel; starting
 *     POSTs /api/leagues/{id}/draft/start. Owner-only controls are gated on
 *     viewer.isOwner, and starting needs >= 2 managers.
 *
 * State arrives over the (mocked) SSE stream; fetch is mocked per endpoint.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import "./setup";

import type { DraftStateData, DraftStatus } from "../../src/web/api-types";
import { DEFAULT_RULESET } from "../../src/data/scoring/ruleset";
import DraftRoom from "../../app/leagues/[leagueId]/draft/draft-room";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>{children}</a>
  ),
}));

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

function baseState(status: DraftStatus, isOwner: boolean, teamCount: number): DraftStateData {
  return {
    status,
    draftRoomId: status === "NONE" ? null : 1,
    pickTimerHours: status === "NONE" ? null : 12,
    rosterSize: 23,
    teamCount,
    totalPicks: 46,
    picksMade: 0,
    currentPickNumber: null,
    currentRound: null,
    currentPickDeadline: null,
    onClockTeamId: null,
    order: [],
    picks: [],
    viewer: {
      managerId: 1, fantasyTeamId: 101, teamName: "Team B",
      isOwner, isOnClock: false,
      roster: [], counts: { GK: 0, DEF: 0, MID: 0, FWD: 0 },
    },
    emailNotifications: true,
  };
}

function resp(data: unknown) {
  return { ok: true, json: async () => ({ data }) } as unknown as Response;
}

let getState: () => DraftStateData;
let fetchMock: ReturnType<typeof vi.fn>;

function setup() {
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/draft/board")) return resp({ players: [] });
    if (u.endsWith("/draft/queue")) return resp({ queue: [] });
    if (init?.method === "POST") return resp({}); // create / start actions
    return resp(getState()); // GET fetchState
  });
  vi.stubGlobal("fetch", fetchMock);
  return render(<DraftRoom leagueId={1} ruleset={DEFAULT_RULESET} />);
}

afterEach(() => vi.unstubAllGlobals());

describe("DraftRoom status=NONE (set up the draft)", () => {
  it("owner: creates the draft and advances to the start screen", async () => {
    const user = userEvent.setup();
    getState = () => baseState("PENDING", true, 2); // what the post-create poll returns
    setup();
    const es = MockEventSource.instances[0]!;
    await act(async () => { es.push(baseState("NONE", true, 1)); });

    expect(screen.getByRole("heading", { name: "Set up the draft" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create draft" }));

    const postCall = fetchMock.mock.calls.find(
      (c) => String(c[0]).endsWith("/api/leagues/1/draft") && (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(postCall).toBeTruthy();
    expect(JSON.parse((postCall![1] as RequestInit).body as string)).toEqual({ pickTimerHours: 12 });

    // After the action re-fetches state, the start screen is shown.
    expect(await screen.findByRole("heading", { name: "Start the draft" })).toBeInTheDocument();
  });

  it("non-owner: sees a waiting notice, no create form", async () => {
    getState = () => baseState("NONE", false, 1);
    setup();
    const es = MockEventSource.instances[0]!;
    await act(async () => { es.push(baseState("NONE", false, 1)); });

    expect(screen.getByText(/has not set up the draft yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create draft" })).not.toBeInTheDocument();
  });
});

describe("DraftRoom status=PENDING (start the draft)", () => {
  it("owner with >= 2 managers: starts the draft via the start endpoint", async () => {
    const user = userEvent.setup();
    getState = () => baseState("PENDING", true, 2);
    setup();
    const es = MockEventSource.instances[0]!;
    await act(async () => { es.push(baseState("PENDING", true, 2)); });

    const startBtn = screen.getByRole("button", { name: "Start draft" });
    expect(startBtn).toBeEnabled();
    await user.click(startBtn);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/leagues/1/draft/start",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("owner with < 2 managers: start is disabled with a hint", async () => {
    getState = () => baseState("PENDING", true, 1);
    setup();
    const es = MockEventSource.instances[0]!;
    await act(async () => { es.push(baseState("PENDING", true, 1)); });

    expect(screen.getByRole("button", { name: "Start draft" })).toBeDisabled();
    expect(screen.getByText(/needs at least 2 managers/)).toBeInTheDocument();
  });

  it("non-owner: sees a waiting notice, no start control", async () => {
    getState = () => baseState("PENDING", false, 2);
    setup();
    const es = MockEventSource.instances[0]!;
    await act(async () => { es.push(baseState("PENDING", false, 2)); });

    expect(screen.getByText(/Waiting for the league owner to start/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start draft" })).not.toBeInTheDocument();
  });
});
