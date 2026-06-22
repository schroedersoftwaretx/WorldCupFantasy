// @vitest-environment jsdom
/**
 * DraftRoom — the live draft room.
 *
 * It subscribes to a Server-Sent Events stream for draft state and fetches the
 * board/queue over HTTP. Here BOTH boundaries are mocked: a controllable
 * EventSource lets the test push state frames, and fetch returns canned board/
 * queue payloads. Nothing touches the network.
 *
 * Behaviour under test:
 *   - before any frame arrives it shows a loading notice;
 *   - the first IN_PROGRESS frame renders the room, the on-clock banner and the
 *     recent-picks ticker;
 *   - a later frame with an extra pick updates the ticker in place (the
 *     "real-time" behaviour).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, act } from "@testing-library/react";

import "./setup";

import type {
  DraftStateData,
  DraftPickLog,
  DraftBoardPlayer,
} from "../../src/web/api-types";
import { DEFAULT_RULESET } from "../../src/data/scoring/ruleset";
import DraftRoom from "../../app/leagues/[leagueId]/draft/draft-room";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

// --- a controllable EventSource ---------------------------------------------
class MockEventSource {
  static instances: MockEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  url: string;
  readyState = MockEventSource.OPEN;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  close() {
    this.readyState = MockEventSource.CLOSED;
  }
  /** Push a state frame the way the server would. */
  push(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

const BOARD: DraftBoardPlayer[] = [
  {
    id: 90, fullName: "Avail Forward", position: "FWD", nationalTeam: "Brazil",
    draftRank: 1, projectedTotalPoints: 40, adp: 3, stageProbabilities: null, legal: true,
  },
];

function pick(n: number, name: string): DraftPickLog {
  return {
    pickNumber: n, round: 1, fantasyTeamId: 100 + (n % 2),
    teamName: n % 2 === 0 ? "Team B" : "Team A",
    playerId: 500 + n, playerName: name, position: "MID", isAutopick: false,
  };
}

function inProgress(picks: DraftPickLog[]): DraftStateData {
  return {
    status: "IN_PROGRESS",
    draftRoomId: 1,
    pickTimerHours: 12,
    rosterSize: 23,
    teamCount: 2,
    totalPicks: 46,
    picksMade: picks.length,
    currentPickNumber: picks.length + 1,
    currentRound: 1,
    currentPickDeadline: new Date(Date.now() + 600_000).toISOString(),
    onClockTeamId: 101,
    order: [
      { slot: 1, fantasyTeamId: 100, teamName: "Team A", managerName: "Alice" },
      { slot: 2, fantasyTeamId: 101, teamName: "Team B", managerName: "Bob" },
    ],
    picks,
    viewer: {
      managerId: 1, fantasyTeamId: 101, teamName: "Team B",
      isOwner: false, isOnClock: true,
      roster: [], counts: { GK: 0, DEF: 0, MID: 0, FWD: 0 },
    },
    emailNotifications: true,
  };
}

function resp(data: unknown) {
  return { ok: true, json: async () => ({ data }) } as unknown as Response;
}

describe("DraftRoom (SSE)", () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.endsWith("/draft/board")) return resp({ players: BOARD });
        if (u.endsWith("/draft/queue")) return resp({ queue: [] });
        return resp({});
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a loading notice before the first frame", () => {
    render(<DraftRoom leagueId={1} ruleset={DEFAULT_RULESET} />);
    expect(screen.getByText("Loading the draft...")).toBeInTheDocument();
    // Exactly one stream was opened to the draft stream endpoint.
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]?.url).toContain("/draft/stream");
  });

  it("renders the room and the picks ticker from the first frame", async () => {
    render(<DraftRoom leagueId={1} ruleset={DEFAULT_RULESET} />);
    const es = MockEventSource.instances[0]!;

    await act(async () => {
      es.push(inProgress([pick(1, "Player One")]));
    });

    expect(await screen.findByText("Draft room")).toBeInTheDocument();
    expect(screen.getByText("You are on the clock")).toBeInTheDocument();

    const ticker = screen.getByLabelText("Recent picks");
    expect(within(ticker).getByText("Player One")).toBeInTheDocument();
  });

  it("updates the ticker in place when a later frame adds a pick", async () => {
    render(<DraftRoom leagueId={1} ruleset={DEFAULT_RULESET} />);
    const es = MockEventSource.instances[0]!;

    await act(async () => {
      es.push(inProgress([pick(1, "Player One")]));
    });
    await act(async () => {
      es.push(inProgress([pick(1, "Player One"), pick(2, "Player Two")]));
    });

    const ticker = screen.getByLabelText("Recent picks");
    expect(within(ticker).getByText("Player One")).toBeInTheDocument();
    expect(within(ticker).getByText("Player Two")).toBeInTheDocument();
  });
});
