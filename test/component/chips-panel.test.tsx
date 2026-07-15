// @vitest-environment jsdom
/**
 * ChipsPanel — captain nomination (best-ball only) and one-shot chip plays.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import "./setup";

import ChipsPanel, {
  type ChipsPeriod,
  type ChipsRosterPlayer,
} from "../../app/leagues/[leagueId]/chips/chips-panel";

afterEach(() => vi.unstubAllGlobals());

const FUTURE = "2099-01-01T00:00:00.000Z";

const periods: ChipsPeriod[] = [
  { scoringPeriodId: 101, ordinal: 1, label: "Group 1", locksAtUtc: FUTURE },
  { scoringPeriodId: 102, ordinal: 2, label: "Group 2", locksAtUtc: FUTURE },
];

const roster: ChipsRosterPlayer[] = [
  { playerId: 1, fullName: "Keeper One", position: "GK" },
  { playerId: 11, fullName: "Defender One", position: "DEF" },
];

const ALL = ["TRIPLE_CAPTAIN", "BENCH_BOOST", "STAGE_BOOST"];

describe("ChipsPanel", () => {
  it("hides the captain section for SET_LINEUP leagues", () => {
    render(
      <ChipsPanel
        leagueId={1}
        teamId={5}
        format="SET_LINEUP"
        periods={periods}
        roster={roster}
        played={[]}
        remaining={ALL}
        captains={[]}
        impact={null}
      />,
    );
    expect(screen.queryByText(/Period captain/)).not.toBeInTheDocument();
    expect(screen.getByText(/set on the Lineup page/)).toBeInTheDocument();
  });

  it("PUTs a captain nomination for best-ball leagues", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: {} }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChipsPanel
        leagueId={3}
        teamId={5}
        format="BEST_BALL"
        periods={periods}
        roster={roster}
        played={[]}
        remaining={ALL}
        captains={[]}
        impact={null}
      />,
    );
    await user.selectOptions(screen.getByRole("combobox", { name: /Player/ }), "11");
    await user.click(screen.getByRole("button", { name: /Set captain/ }));

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/leagues/3/chips/captain");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toMatchObject({
      teamId: 5,
      scoringPeriodId: 101,
      playerId: 11,
    });
    expect(await screen.findByText(/Group 1: Defender One/)).toBeInTheDocument();
  });

  it("POSTs a chip play and moves the chip to the played list", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: {} }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChipsPanel
        leagueId={3}
        teamId={5}
        format="BEST_BALL"
        periods={periods}
        roster={roster}
        played={[]}
        remaining={["STAGE_BOOST"]}
        captains={[]}
        impact={null}
      />,
    );
    await user.selectOptions(
      screen.getAllByRole("combobox", { name: /Period/ })[1] as HTMLElement,
      "102",
    );
    await user.click(screen.getByRole("button", { name: /Play chip/ }));

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/leagues/3/chips");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({
      teamId: 5,
      scoringPeriodId: 102,
      chip: "STAGE_BOOST",
    });
    expect(await screen.findByText(/All chips used/)).toBeInTheDocument();
    expect(screen.getByText(/played on/)).toBeInTheDocument();
  });

  it("surfaces API errors (e.g. chip already used)", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: { message: "TRIPLE_CAPTAIN has already been used" } }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChipsPanel
        leagueId={3}
        teamId={5}
        format="BEST_BALL"
        periods={periods}
        roster={roster}
        played={[]}
        remaining={["TRIPLE_CAPTAIN"]}
        captains={[]}
        impact={null}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Play chip/ }));
    expect(
      await screen.findByText(/has already been used/),
    ).toBeInTheDocument();
  });
});
