// @vitest-environment jsdom
/**
 * PlayerStatsProvider + PlayerStatButton — the lazy player score-breakdown modal.
 *
 * Behaviour under test:
 *   - outside a provider, PlayerStatButton is inert plain text (always safe);
 *   - inside a provider, clicking opens a modal, fetches that player's breakdown
 *     from the league endpoint (or the public Stats Hub endpoint when no
 *     leagueId), and renders the per-fixture rule rows;
 *   - the modal closes on Escape and on a backdrop click.
 *
 * fetch is mocked; nothing hits the network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import "./setup";

import type { PlayerBreakdown } from "../../src/data/standings/player-breakdown";
import {
  PlayerStatsProvider,
  PlayerStatButton,
} from "../../app/leagues/[leagueId]/player-stats-modal";

const breakdown: PlayerBreakdown = {
  playerId: 55,
  fullName: "Lionel Tester",
  position: "FWD",
  rulesetVersion: "wcf-test",
  ownership: { ownedCount: 3, ownershipPct: 0.6, totalFantasyTeams: 5 },
  adp: 7,
  fixtures: [
    {
      fixtureId: 901,
      stage: "GROUP_1",
      opponent: "vs Mexico",
      kickoffUtc: "2026-06-12T00:00:00Z",
      total: 9,
      rules: [
        { key: "goals", label: "Goals", count: 2, points: 8 },
        { key: "appearance", label: "Appearance", count: null, points: 1 },
      ],
    },
  ],
};

function mockFetchOk() {
  const fn = vi.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true, data: breakdown }),
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("PlayerStatButton without a provider", () => {
  it("renders the name as plain text, not a button", () => {
    render(<PlayerStatButton playerId={55} fullName="Lionel Tester" />);
    expect(screen.getByText("Lionel Tester")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("PlayerStatsProvider modal", () => {
  beforeEach(() => {
    mockFetchOk();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderWithProvider(leagueId?: number) {
    return render(
      <PlayerStatsProvider {...(leagueId !== undefined ? { leagueId } : {})}>
        <PlayerStatButton playerId={55} fullName="Lionel Tester" />
      </PlayerStatsProvider>,
    );
  }

  it("opens the modal and fetches the league breakdown on click", async () => {
    const user = userEvent.setup();
    renderWithProvider(12);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Lionel Tester" }));

    const dialog = screen.getByRole("dialog");
    expect(fetch).toHaveBeenCalledWith("/api/leagues/12/players/55/breakdown");

    // Fixture breakdown renders once the fetch resolves.
    expect(await within(dialog).findByText(/Group Stage MD1/)).toBeInTheDocument();
    expect(within(dialog).getByText(/vs Mexico/)).toBeInTheDocument();
    expect(within(dialog).getByText("Goals")).toBeInTheDocument();
    expect(within(dialog).getByText("Appearance")).toBeInTheDocument();
    // Ownership + ADP context line.
    expect(within(dialog).getByText(/Owned 60%/)).toBeInTheDocument();
    expect(within(dialog).getByText(/ADP 7/)).toBeInTheDocument();
  });

  it("uses the public Stats Hub endpoint when no leagueId is given", async () => {
    const user = userEvent.setup();
    renderWithProvider(undefined);
    await user.click(screen.getByRole("button", { name: "Lionel Tester" }));
    expect(fetch).toHaveBeenCalledWith("/api/stats/players/55/breakdown");
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    renderWithProvider(12);
    await user.click(screen.getByRole("button", { name: "Lionel Tester" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes on a backdrop click but not when the panel is clicked", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProvider(12);
    await user.click(screen.getByRole("button", { name: "Lionel Tester" }));

    // Clicking inside the panel keeps it open.
    await user.click(await within(screen.getByRole("dialog")).findByText("Goals"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Clicking the backdrop closes it.
    fireEvent.click(container.querySelector(".xi-overlay") as HTMLElement);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes via the explicit close button", async () => {
    const user = userEvent.setup();
    renderWithProvider(12);
    await user.click(screen.getByRole("button", { name: "Lionel Tester" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
