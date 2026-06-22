// @vitest-environment jsdom
/**
 * PitchSvg / BestLineupViz click-to-open-stats.
 *
 * The pitch's filled player circles open the score-breakdown modal ONLY when
 * rendered inside <PlayerStatsProvider> (which supplies a non-null openStats).
 * Behaviour under test:
 *   - a filled circle is a role="button" that opens the modal and fetches that
 *     player's breakdown;
 *   - empty / placeholder slots are not clickable (no button role).
 *
 * The lineup math itself is covered in test/unit/best-lineup.test.ts; here we
 * only assert the interaction wiring, so the roster is shaped to leave the FWD
 * row empty (3 placeholder slots) alongside 7 filled, clickable circles.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import "./setup";

import type { PlayerBreakdown } from "../../src/data/standings/player-breakdown";
import { BestLineupViz, type Player } from "../../app/leagues/[leagueId]/draft/best-lineup";
import { PlayerStatsProvider } from "../../app/leagues/[leagueId]/player-stats-modal";

// 1 GK + 4 DEF + 2 MID, no FWD -> the FWD row renders 3 empty placeholders.
const roster: Player[] = [
  { playerId: 1, fullName: "Manuel Keeper", position: "GK", draftRank: 1 },
  { playerId: 2, fullName: "Def One", position: "DEF", draftRank: 2 },
  { playerId: 3, fullName: "Def Two", position: "DEF", draftRank: 3 },
  { playerId: 4, fullName: "Def Three", position: "DEF", draftRank: 4 },
  { playerId: 5, fullName: "Def Four", position: "DEF", draftRank: 5 },
  { playerId: 6, fullName: "Mid One", position: "MID", draftRank: 6 },
  { playerId: 7, fullName: "Mid Two", position: "MID", draftRank: 7 },
];

const breakdown: PlayerBreakdown = {
  playerId: 1,
  fullName: "Manuel Keeper",
  position: "GK",
  rulesetVersion: "wcf-test",
  ownership: { ownedCount: 1, ownershipPct: 0.5, totalFantasyTeams: 2 },
  adp: 3,
  fixtures: [
    {
      fixtureId: 700,
      stage: "GROUP_1",
      opponent: "vs Mexico",
      kickoffUtc: "2026-06-12T00:00:00Z",
      total: 6,
      rules: [{ key: "saves", label: "Saves", count: 3, points: 3 }],
    },
  ],
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, data: breakdown }) })),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderViz() {
  return render(
    <PlayerStatsProvider leagueId={9}>
      <BestLineupViz roster={roster} />
    </PlayerStatsProvider>,
  );
}

describe("PitchSvg click-to-open-stats", () => {
  it("makes only the filled circles clickable (one button per rostered player)", () => {
    const { container } = renderViz();
    // 7 filled players -> 7 buttons; 3 empty FWD slots -> not buttons.
    expect(screen.getAllByRole("button")).toHaveLength(roster.length);
    const empties = container.querySelectorAll("g.pitch-player:not(.clickable)");
    expect(empties).toHaveLength(3);
    empties.forEach((g) => expect(g).not.toHaveAttribute("role", "button"));
  });

  it("opens the modal and fetches the clicked player's breakdown", async () => {
    const user = userEvent.setup();
    renderViz();

    const keeperBtn = screen
      .getAllByRole("button")
      .find((b) => b.textContent?.includes("Keeper"))!;
    await user.click(keeperBtn);

    const dialog = await screen.findByRole("dialog");
    expect(fetch).toHaveBeenCalledWith("/api/leagues/9/players/1/breakdown");
    expect(await within(dialog).findByText(/Group Stage MD1/)).toBeInTheDocument();
    expect(within(dialog).getByText("Saves")).toBeInTheDocument();
  });

  it("does not open the modal when there is no provider (circles inert)", () => {
    render(<BestLineupViz roster={roster} />);
    // Outside a provider openStats is null -> no clickable circles at all.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
