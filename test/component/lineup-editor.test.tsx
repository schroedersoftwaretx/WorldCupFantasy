// @vitest-environment jsdom
/**
 * LineupEditor — SET_LINEUP XI picker: legality gating, submission payload,
 * kickoff lock, and the roll-forward notice.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import "./setup";

import LineupEditor, {
  type ExistingLineup,
  type LineupPeriod,
  type LineupRosterPlayer,
} from "../../app/leagues/[leagueId]/lineup/lineup-editor";

afterEach(() => vi.unstubAllGlobals());

const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";

function roster(): LineupRosterPlayer[] {
  const out: LineupRosterPlayer[] = [];
  for (let i = 1; i <= 2; i += 1) out.push({ playerId: i, fullName: `G${i}`, position: "GK" });
  for (let i = 1; i <= 8; i += 1) out.push({ playerId: 10 + i, fullName: `D${i}`, position: "DEF" });
  for (let i = 1; i <= 8; i += 1) out.push({ playerId: 20 + i, fullName: `M${i}`, position: "MID" });
  for (let i = 1; i <= 5; i += 1) out.push({ playerId: 30 + i, fullName: `F${i}`, position: "FWD" });
  return out;
}

const XI_433 = [1, 11, 12, 13, 14, 21, 22, 23, 31, 32, 33];

const openPeriod: LineupPeriod = {
  scoringPeriodId: 101,
  ordinal: 1,
  label: "Group 1",
  locksAtUtc: FUTURE,
};

async function pickXi(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const names = ["G1", "D1", "D2", "D3", "D4", "M1", "M2", "M3", "F1", "F2", "F3"];
  for (const n of names) {
    await user.click(screen.getByRole("checkbox", { name: new RegExp(`^${n}$`) }));
  }
}

describe("LineupEditor", () => {
  it("keeps Save disabled until a legal XI and captain are picked", async () => {
    const user = userEvent.setup();
    render(
      <LineupEditor
        leagueId={1}
        teamId={5}
        roster={roster()}
        periods={[openPeriod]}
        lineups={[]}
      />,
    );
    const save = screen.getByRole("button", { name: /Save lineup/ });
    expect(save).toBeDisabled();

    await pickXi(user);
    expect(save).toBeDisabled(); // still no captain

    await user.selectOptions(
      screen.getByRole("combobox", { name: /Captain/ }),
      "1",
    );
    expect(save).toBeEnabled();
  });

  it("PUTs the selected XI, captain and vice", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: {} }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <LineupEditor
        leagueId={7}
        teamId={5}
        roster={roster()}
        periods={[openPeriod]}
        lineups={[]}
      />,
    );
    await pickXi(user);
    await user.selectOptions(screen.getByRole("combobox", { name: /Captain/ }), "1");
    await user.selectOptions(screen.getByRole("combobox", { name: /Vice/ }), "31");
    await user.click(screen.getByRole("button", { name: /Save lineup/ }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/leagues/7/lineup");
    expect(init.method).toBe("PUT");
    const body = JSON.parse(String(init.body)) as {
      teamId: number;
      scoringPeriodId: number;
      playerIds: number[];
      captainPlayerId: number;
      viceCaptainPlayerId: number | null;
    };
    expect(body.teamId).toBe(5);
    expect(body.scoringPeriodId).toBe(101);
    expect([...body.playerIds].sort((a, b) => a - b)).toEqual(XI_433);
    expect(body.captainPlayerId).toBe(1);
    expect(body.viceCaptainPlayerId).toBe(31);
    expect(await screen.findByText(/Lineup saved/)).toBeInTheDocument();
  });

  it("locks a period whose first kickoff has passed", () => {
    render(
      <LineupEditor
        leagueId={1}
        teamId={5}
        roster={roster()}
        periods={[{ ...openPeriod, locksAtUtc: PAST }]}
        lineups={[]}
      />,
    );
    expect(screen.getByRole("button", { name: /Save lineup/ })).toBeDisabled();
    expect(screen.getByText(/This period is locked/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /^G1$/ })).toBeDisabled();
  });

  it("shows the roll-forward notice for periods without their own lineup", () => {
    const locked: LineupPeriod = { ...openPeriod, locksAtUtc: PAST };
    const open2: LineupPeriod = {
      scoringPeriodId: 102,
      ordinal: 2,
      label: "Group 2",
      locksAtUtc: FUTURE,
    };
    const existing: ExistingLineup = {
      scoringPeriodId: 101,
      playerIds: XI_433,
      captainPlayerId: 1,
      viceCaptainPlayerId: null,
    };
    render(
      <LineupEditor
        leagueId={1}
        teamId={5}
        roster={roster()}
        periods={[locked, open2]}
        lineups={[existing]}
      />,
    );
    // Defaults to the first open period (Group 2) and rolls Group 1 forward.
    expect(screen.getByText(/rolls forward/)).toBeInTheDocument();
    expect(screen.getByText(/Selected 11\/11/)).toBeInTheDocument();
  });
});
